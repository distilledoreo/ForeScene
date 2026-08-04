import { describe, expect, it } from 'vitest';
import { createBlankGrayboxProject } from '../src/engine/previs/blankProject';
import { createPanoReference } from '../src/domain/defaults';
import { createProjectPackage, readProjectFile } from '../src/engine/projectIO';
import { useProjectStore } from '../src/state/useProjectStore';

const ROMAN_PANO_ID = 'pano_minimal_roman';
const ARMORY_PANO_ID = 'pano_minimal_armory';

function createMinimalPanoramaProject() {
  const project = createBlankGrayboxProject({ name: 'Panorama Persistence Minimal Repro' });
  project.id = 'project_panorama_minimal_repro_v1';
  const roman = createPanoReference({
    name: 'Roman',
    assetId: 'asset_minimal_roman',
    type: 'ai_global_reference',
    origin: [0, 1.2, 0],
    width: 8,
    height: 4,
    isCanonical: true,
  });
  roman.id = ROMAN_PANO_ID;
  const armory = createPanoReference({
    name: 'Armory',
    assetId: 'asset_minimal_armory',
    type: 'ai_global_reference',
    origin: [0, 1.2, 0],
    width: 8,
    height: 4,
  });
  armory.id = ARMORY_PANO_ID;
  project.panoRefs = [roman, armory];
  project.shots = [
    { ...project.shots[0], id: 'shot_minimal_01', shotNumber: '01', linkedPanoId: ROMAN_PANO_ID },
    { ...structuredClone(project.shots[0]), id: 'shot_minimal_02', shotNumber: '02', linkedPanoId: ARMORY_PANO_ID },
  ];
  return project;
}

function shotPanos(project: ReturnType<typeof createMinimalPanoramaProject>) {
  return project.shots.map((shot) => shot.linkedPanoId);
}

describe('shot-scoped panorama persistence', () => {
  it('preserves distinct shot panoramas through save, export/import, recovery, and cloning', async () => {
    const source = createMinimalPanoramaProject();
    const expected = [ROMAN_PANO_ID, ARMORY_PANO_ID];
    expect(shotPanos(source)).toEqual(expected);

    const packageBlob = await createProjectPackage(source);
    const imported = await readProjectFile(new File([packageBlob], 'panorama-persistence-minimal-repro.fsp'));
    expect(imported.shots).toHaveLength(2);
    expect(shotPanos(imported as ReturnType<typeof createMinimalPanoramaProject>)).toEqual(expected);

    useProjectStore.getState().setProject(structuredClone(imported));
    expect(shotPanos(useProjectStore.getState().project as ReturnType<typeof createMinimalPanoramaProject>)).toEqual(expected);

    const recovered = structuredClone(imported);
    useProjectStore.getState().setProject(recovered);
    expect(shotPanos(useProjectStore.getState().project as ReturnType<typeof createMinimalPanoramaProject>)).toEqual(expected);

    const clone = structuredClone(imported);
    clone.id = 'project_panorama_minimal_clone_v1';
    clone.name = 'Panorama Persistence Minimal Clone';
    useProjectStore.getState().setProject(clone);
    expect(useProjectStore.getState().project.id).toBe('project_panorama_minimal_clone_v1');
    expect(shotPanos(useProjectStore.getState().project as ReturnType<typeof createMinimalPanoramaProject>)).toEqual(expected);
    expect(shotPanos(imported as ReturnType<typeof createMinimalPanoramaProject>)).toEqual(expected);
  });
});
