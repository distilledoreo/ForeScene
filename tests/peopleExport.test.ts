import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import {
  getPeopleRenderVariants,
  getPeopleVariantPath,
} from '../src/engine/peopleExport';
import { resolveProjectForShot } from '../src/engine/shotSceneState';

describe('people output variants', () => {
  it('preserves legacy names for with-people-only and suffixes dual outputs', () => {
    expect(getPeopleRenderVariants('with_people')).toEqual(['with_people']);
    expect(getPeopleRenderVariants('both')).toEqual(['with_people', 'clean_plate']);
    expect(getPeopleVariantPath('viewport.png', 'with_people', 'with_people')).toBe('viewport.png');
    expect(getPeopleVariantPath('viewport.png', 'with_people', 'both')).toBe('viewport_with_people.png');
    expect(getPeopleVariantPath('viewport.png', 'clean_plate', 'both')).toBe('viewport_clean_plate.png');
  });

  it('hides built-in and imported people without changing props', () => {
    const project = createDefaultProject();
    const mannequin = createSceneObject('human_dummy', 1);
    const importedPerson = createSceneObject('imported_model', 1);
    importedPerson.stagingRole = 'person';
    const prop = createSceneObject('box', 1);
    prop.stagingRole = 'prop';
    project.scene.objects.push(mannequin, importedPerson, prop);

    const clean = resolveProjectForShot(project, project.shots[0], { contentMode: 'clean_plate' });
    const byId = new Map(clean.scene.objects.map((object) => [object.id, object]));
    expect(byId.get(mannequin.id)?.visible).toBe(false);
    expect(byId.get(importedPerson.id)?.visible).toBe(false);
    expect(byId.get(prop.id)?.visible).toBe(true);
  });

  it('lists paired still paths in a both-mode package manifest', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.exportSettings.peopleExportMode = 'both';
    shot.exportSettings.includeProjectedViewport = false;
    const paths = createShotPackageManifest(project, shot).files.map((file) => file.path);
    expect(paths.some((path) => path.endsWith('/viewport_clay_with_people.png'))).toBe(true);
    expect(paths.some((path) => path.endsWith('/viewport_clay_clean_plate.png'))).toBe(true);
  });
});
