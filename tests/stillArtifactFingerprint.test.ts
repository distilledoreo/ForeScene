import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
function s(k: string, a: string, e: Record<string, unknown> = {}){ return { kind:k, appearance:a, width:1920, height:1080, ...e } as never; }
describe('still fingerprint',()=>{
  it('identical produces same',()=>{ const pr=createDefaultProject(); const sh=pr.shots[0]!; const spec=s('clay-viewport','clay',{peopleVariant:'with_people'}); expect(computeStillArtifactFingerprint(pr,sh,spec).key).toBe(computeStillArtifactFingerprint(pr,sh,spec).key); });
  it('camera invalidates',()=>{ const pr=createDefaultProject(); const sh=pr.shots[0]!; const spec=s('clay-viewport','clay',{peopleVariant:'with_people'}); const b=computeStillArtifactFingerprint(pr,sh,spec).key; sh.camera.fovDegrees+=5; expect(computeStillArtifactFingerprint(pr,sh,spec).key).not.toBe(b); });
});
