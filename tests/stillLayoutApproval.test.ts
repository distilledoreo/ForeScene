import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  createApprovedLayoutRevision,
  createMotionWorkingRevision,
  verifyApprovedLayoutRevision,
  verifyStillLayoutIsolation,
} from '../src/engine/previs/stillLayoutApproval';

describe('still-layout approval isolation', () => {
  it('records a project fingerprint and rejects later drift', () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    const approval = createApprovedLayoutRevision({
      revisionId: 'revision-still-1',
      project,
      approvedShotIds: [shotId],
      reviewArtifactIds: ['sheet-1'],
    });

    expect(verifyApprovedLayoutRevision(project, approval).ok).toBe(true);
    project.shots[0]!.camera.fovDegrees += 3;
    const drift = verifyApprovedLayoutRevision(project, approval);
    expect(drift.ok).toBe(false);
    expect(drift.errors[0]).toContain('fingerprint');
  });

  it('clones motion work without mutating the approved still project', () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    const approval = createApprovedLayoutRevision({
      revisionId: 'revision-still-2',
      project,
      approvedShotIds: [shotId],
    });
    const motion = createMotionWorkingRevision({ project, approval });

    motion.project.shots[0]!.camera.position[0] += 1;
    expect(motion.project).not.toBe(project);
    expect(project.shots[0]!.camera.position[0]).not.toBe(motion.project.shots[0]!.camera.position[0]);
    expect(verifyStillLayoutIsolation({
      approvedProject: project,
      workingProject: motion.project,
      approvedShotIds: [shotId],
    }).ok).toBe(false);
  });
});
