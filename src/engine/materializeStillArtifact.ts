import type { LocationProject, MaterializedStillArtifact, ProjectAsset, Shot } from '../domain/types';
import { createId } from '../utils/ids';
import { dataUrlToBlob } from './fileTransfers';
import { createProjectAssetStorageKey, deleteProjectAssetBlob, storeProjectAssetBlob } from './projectAssetStore';
import { getSortedCameraKeyframes, interpolateCameraKeyframes } from './cameraKeyframes';
import { renderShotFrame, renderShotProjectedFrame, renderShotCharacterFrame, renderViewportClay, renderViewportProjected } from './renderers';
import { renderShotDepthFrame, renderViewportDepth } from './depthRender';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from './stillArtifactTypes';

export interface MaterializedStillResult { project: LocationProject; artifact: MaterializedStillArtifact; reused: boolean; blob?: Blob; }
const inflight = new Map<string, Promise<MaterializedStillResult>>();
function cancelErr(): Error { const e = new Error('Still materialization was cancelled.'); (e as Error & { name?: string }).name = 'AbortError'; return e; }
function throwIfCancelled(s?: AbortSignal): void { if (s?.aborted) throw cancelErr(); }
function resolveShot(p: LocationProject, id: string): Shot { const s=p.shots.find(x=>x.id===id); if(!s) throw new Error('Shot '+id+' not found.'); return s; }
function refCam(shot: Shot, t?: number){ if(t===undefined) return shot.camera; const kfs=getSortedCameraKeyframes(shot.cameraKeyframes); if(!kfs.length) return shot.camera; try{return interpolateCameraKeyframes(kfs,t);}catch{return shot.camera;} }
function projForRef(project: LocationProject, spec: StillArtifactSpecification): LocationProject {
  if(spec.peopleVariant==='clean_plate'||spec.contentMode==='clean_plate'){ return {...project, scene:{...project.scene, objects: project.scene.objects.filter(o=>o.stagingRole!=='person')}}; }
  if(spec.contentMode==='characters_only'){ return {...project, scene:{...project.scene, objects: project.scene.objects.filter(o=>o.stagingRole==='person'||(spec.includeCharacterAttachments!==false && typeof o.metadata?.characterOwnerId==='string'))}}; }
  return project;
}
async function renderBlob(project: LocationProject, shot: Shot, spec: StillArtifactSpecification): Promise<{blob:Blob;width:number;height:number}>{
  switch(spec.kind){
    case 'clay-viewport':{const r=await renderShotFrame(project,shot,{peopleVariant:spec.peopleVariant});return {blob:dataUrlToBlob(r.dataUrl),width:r.width,height:r.height};}
    case 'projected-viewport':{const r=await renderShotProjectedFrame(project,shot,{peopleVariant:spec.peopleVariant});return {blob:dataUrlToBlob(r.dataUrl),width:r.width,height:r.height};}
    case 'depth-viewport':{const r=await renderShotDepthFrame(project,shot,{peopleVariant:spec.peopleVariant});return {blob:dataUrlToBlob(r.dataUrl),width:r.width,height:r.height};}
    case 'character-still':{const r=await renderShotCharacterFrame(project,shot,{appearance:spec.appearance==='depth'?'clay':spec.appearance,includeAttachedProps:spec.includeCharacterAttachments!==false});return {blob:r.blob,width:r.width,height:r.height};}
    case 'clay-reference-frame':{const cam=refCam(shot,spec.timeSeconds);const r=await renderViewportClay(projForRef(project,spec),cam,spec.width,spec.height);return {blob:dataUrlToBlob(r.dataUrl),width:r.width,height:r.height};}
    case 'projected-reference-frame':{const cam=refCam(shot,spec.timeSeconds);const r=await renderViewportProjected(projForRef(project,spec),cam,spec.width,spec.height);return {blob:dataUrlToBlob(r.dataUrl),width:r.width,height:r.height};}
    case 'depth-reference-frame':{const cam=refCam(shot,spec.timeSeconds);const r=await renderViewportDepth(projForRef(project,spec),cam,spec.width,spec.height);return {blob:dataUrlToBlob(r.dataUrl),width:r.width,height:r.height};}
    default: throw new Error('Unsupported still kind '+(spec as StillArtifactSpecification).kind);
  }
}
export async function materializeStillArtifact(params:{project:LocationProject;shotId:string;specification:StillArtifactSpecification;signal?:AbortSignal}):Promise<MaterializedStillResult>{
  const {project, shotId, specification, signal}=params; throwIfCancelled(signal);
  const shot=resolveShot(project,shotId); const fp=computeStillArtifactFingerprint(project,shot,specification); const key=stillArtifactKey(specification);
  const existing=shot.materializedMedia?.stills[key];
  if(existing&&existing.fingerprint===fp.key){ const asset=project.assets.assets[existing.assetId]; if(asset&&existing.width===specification.width&&existing.height===specification.height) return {project,artifact:existing,reused:true}; }
  const inflightKey=fp.key; const ej=inflight.get(inflightKey);
  if(ej){
    if(signal) return new Promise<MaterializedStillResult>((resolve,reject)=>{const onAbort=()=>reject(cancelErr()); signal.addEventListener('abort',onAbort,{once:true}); ej.then(res=>{signal.removeEventListener('abort',onAbort); const live=res.project.shots.find(s=>s.id===shotId); const liveFp=live?computeStillArtifactFingerprint(res.project,live,specification).key:fp.key; if(liveFp!==fp.key) reject(new Error('Stale still result discarded due to concurrent edit.')); else resolve(res);},reject);});
    return ej;
  }
  const job=(async():Promise<MaterializedStillResult>=>{
    throwIfCancelled(signal); const rendered=await renderBlob(project,shot,specification); throwIfCancelled(signal);
    const assetId=createId('asset'); const base:ProjectAsset={id:assetId,type:'image',name:shot.shotNumber+'_'+key+'.png',uri:'',storageKey:createProjectAssetStorageKey(project.id,assetId),mimeType:'image/png',width:rendered.width,height:rendered.height,createdAt:new Date().toISOString(),metadata:{provenance:'forescene-derived-still',ownerShotId:shotId,artifactKey:key,fingerprint:fp.key}};
    const stored=storeProjectAssetBlob(project.id,base,rendered.blob);
    const artifact:MaterializedStillArtifact={id:createId('still-artifact'),key,kind:specification.kind,assetId:stored.id,fingerprint:fp.key,dependencyIds:fp.dependencyIds,width:rendered.width,height:rendered.height,mimeType:'image/png',peopleVariant:specification.peopleVariant,appearance:specification.appearance,timeSeconds:specification.timeSeconds,frameRole:specification.frameRole,createdAt:new Date().toISOString()};
    const nextShots=project.shots.map(s=> s.id!==shotId? s : {...s, materializedMedia:{stills:{...(s.materializedMedia?.stills??{}),[key]:artifact}}, updatedAt:new Date().toISOString()});
    const nextAssets:LocationProject['assets']={...project.assets, assets:{...project.assets.assets,[stored.id]:stored}};
    let nextProject:LocationProject={...project, shots:nextShots, assets:nextAssets, updatedAt:new Date().toISOString()};
    const updated=nextProject.shots.find(s=>s.id===shotId)!; const cur=computeStillArtifactFingerprint(nextProject,updated,specification).key;
    if(cur!==fp.key){ const rev={...updated.materializedMedia!.stills}; if(existing&&existing.fingerprint===cur) rev[key]=existing; else delete rev[key]; nextProject={...nextProject, shots: nextProject.shots.map(s=> s.id===shotId? {...s, materializedMedia:{stills:rev}}:s)}; throw new Error('Stale still result discarded due to concurrent edit.'); }
    const oldId=existing?.assetId; if(oldId&&oldId!==stored.id){ const stillRef=nextProject.shots.some(s=> Object.values(s.materializedMedia?.stills??{}).some(a=>a.assetId===oldId)); const leg=nextProject.shots.some(s=> Object.values(s.assets).includes(oldId as string)); if(!stillRef&&!leg){ const oldAsset=project.assets.assets[oldId]; const k=oldAsset?.storageKey ?? createProjectAssetStorageKey(project.id,oldId); void deleteProjectAssetBlob(k).catch(()=>undefined);} }
    return {project:nextProject, artifact, reused:false, blob:rendered.blob};
  })();
  inflight.set(inflightKey,job);
  try{ return await job; } finally{ if(inflight.get(inflightKey)===job) inflight.delete(inflightKey); }
}
export function inspectMaterializeStillInflightForTests(){ return {jobs:inflight.size, keys:[...inflight.keys()]}; }
export function resetMaterializeStillInflightForTests(){ inflight.clear(); }

