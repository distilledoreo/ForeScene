import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { resolveManifestEntityMemberTransforms } from '../src/engine/previs/manifestEntityTransforms';

describe('manifest entity transforms', () => {
  it('keeps multipart imported members rigid when the group root leans', () => {
    const project = createDefaultProject();
    const body = createSceneObject('imported_model', 1);
    const eye = createSceneObject('imported_model', 2);
    body.id = 'body';
    eye.id = 'eye';
    body.transform.position = [0, 0.5, 0];
    eye.transform.position = [0, 1.1, 0.4];
    project.scene.objects = [body, eye];

    const restDistance = Math.hypot(
      eye.transform.position[0] - body.transform.position[0],
      eye.transform.position[1] - body.transform.position[1],
      eye.transform.position[2] - body.transform.position[2],
    );
    const members = resolveManifestEntityMemberTransforms({
      mapping: { groupId: 'creature', objectIds: ['body', 'eye'] },
      project,
      targetTransform: {
        position: [10, 0.8, -4],
        rotation: [34, 0, 0],
        scale: [1, 1, 1],
      },
    });
    const nextBody = members.find((member) => member.objectId === 'body')!.transform.position;
    const nextEye = members.find((member) => member.objectId === 'eye')!.transform.position;
    expect(members).toHaveLength(2);
    expect(nextBody).not.toEqual(nextEye);
    expect(Math.hypot(
      nextEye[0] - nextBody[0],
      nextEye[1] - nextBody[1],
      nextEye[2] - nextBody[2],
    )).toBeCloseTo(restDistance, 5);
  });
});
