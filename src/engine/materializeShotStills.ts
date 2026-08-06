import type { LocationProject, Shot } from '../domain/types';
import { getCameraMoveReferenceFrames } from './cameraKeyframes';
import { renderWorkCoordinator } from './renderWorkCoordinator';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from './stillArtifactTypes';
import { materializeStillArtifact } from './materializeStillArtifact';
import { shouldExportViewportDepth, shouldExportDepthReferenceFrames } from './depthRender';
import { getPeopleRenderVariants } from './peopleExport';
import { canUseProjectedAppearance } from './projectedStyle';
import { shotHasVisibleCharactersForPass } from './characterPassExport';
export type MaterializeReason='capture'|'edit'|'manual'|'export-recovery';
export type MaterializeScope='primary'|'all-configured'|'stale-only';
function buildSpecs(project: LocationProject, shot: Shot): StillArtifactSpecification[]{
  const w=shot.exportSettings.width, h=shot.exportSettings.height;
  const vars=getPeopleRenderVariants(shot.exportSettings.peopleExportMode);
  const specs: StillArtifactSpecification[]=[];
  for(const v of vars) if(shot.exportSettings.includeViewport) specs.push({kind:'clay-viewport',appearance:'clay',peopleVariant:v,width:w,height:h});
  if(shot.exportSettings.includeProjectedViewport && canUseProjectedAppearance(project)) for(const v of vars) specs.push({kind:'projected-viewport',appearance:'projected',peopleVariant:v,width:w,height:h});
  if(shouldExportViewportDepth(shot.exportSettings.depth)) for(const v of vars) specs.push({kind:'depth-viewport',appearance:'depth',peopleVariant:v,width:w,height:h});
  const cp=shot.exportSettings.characterPass;
  if(cp.enabled && shotHasVisibleCharactersForPass(project,shot,cp)) specs.push({kind:'character-still',appearance:'clay',contentMode:'characters_only',includeCharacterAttachments:cp.includeAttachedProps,width:w,height:h,backgroundColor:cp.backgroundColor});
  const frames=getCameraMoveReferenceFrames(shot.cameraKeyframes);
  if(frames.length){ const wantClay=shot.exportSettings.includeCameraMoveReferenceFrames; const wantProj=shot.exportSettings.includeProjectedCameraMoveReferenceFrames && canUseProjectedAppearance(project); const wantDepth=shouldExportDepthReferenceFrames(shot.exportSettings.depth,true);
    for(const f of frames){ const role=f.id==='start'?'start':f.id==='mid'?'middle':'end'; if(wantClay) for(const v of vars) specs.push({kind:'clay-reference-frame',appearance:'clay',peopleVariant:v,width:w,height:h,timeSeconds:f.timeSeconds,frameRole:role as StillArtifactSpecification['frameRole']}); if(wantProj) for(const v of vars) specs.push({kind:'projected-reference-frame',appearance:'projected',peopleVariant:v,width:w,height:h,timeSeconds:f.timeSeconds,frameRole:role as StillArtifactSpecification['frameRole']}); if(wantDepth) for(const v of vars) specs.push({kind:'depth-reference-frame',appearance:'depth',peopleVariant:v,width:w,height:h,timeSeconds:f.timeSeconds,frameRole:role as StillArtifactSpecification['frameRole']});}}
  return specs;
}
function score(s: StillArtifactSpecification){ if(s.frameRole){const r=s.frameRole==='start'?0:s.frameRole==='middle'?1:2; const a=s.appearance==='clay'?0:s.appearance==='projected'?1:2; return 10+a*3+r;} if(s.kind==='character-still') return 8; if(s.kind==='depth-viewport') return 5; if(s.kind==='clay-viewport'&&s.peopleVariant==='with_people') return 0; if(s.kind==='projected-viewport'&&s.peopleVariant==='with_people') return 1; if(s.kind==='clay-viewport') return 2; if(s.kind==='projected-viewport') return 3; return 6; }
export function buildStillArtifactSpecificationsForShot(project: LocationProject, shot: Shot){ return buildSpecs(project,shot); }
export async function materializeShotStills(params:{project:LocationProject;shotId:string;reason:MaterializeReason;scope?:MaterializeScope;signal?:AbortSignal}){
  const {shotId, signal}=params; let project=params.project; const shot0=project.shots.find(s=>s.id===shotId); if(!shot0) throw new Error('Shot '+shotId+' not found.');
  let specs=buildSpecs(project, shot0);
  if(params.scope==='primary'){ specs=specs.filter(s=> !s.frameRole && s.kind!=='character-still' && (s.peopleVariant==='with_people'||!s.peopleVariant)); const prim=specs.find(s=> s.kind==='clay-viewport'&&s.peopleVariant==='with_people') ?? specs[0]; specs=prim?[prim]:[]; }
  else if(params.scope==='stale-only'){ specs=specs.filter(s=>{const k=stillArtifactKey(s); const ex=shot0.materializedMedia?.stills[k]; if(!ex) return true; const fp=computeStillArtifactFingerprint(project,shot0,s).key; return ex.fingerprint!==fp;});}
  specs.sort((a,b)=>score(a)-score(b));
  const statuses: Array<{key:string;status:'reused'|'rendered'}>=[];
  for(const spec of specs){ if(signal?.aborted) throw new Error('Still materialization was cancelled.'); const key=stillArtifactKey(spec); const live=project.shots.find(s=>s.id===shotId); if(!live) break; const exp=computeStillArtifactFingerprint(project,live,spec).key; const cur=live.materializedMedia?.stills[key]; if(cur && cur.fingerprint===exp){ statuses.push({key,status:'reused'}); continue; } const prio=(spec.frameRole ? 'interactive-secondary-still' : 'interactive-primary-still') as const; const res=await renderWorkCoordinator.schedule(prio, ()=> materializeStillArtifact({project, shotId, specification:spec, signal})); project=(res as {project:LocationProject}).project; statuses.push({key,status:'rendered'}); }
  return {project, statuses};
}
