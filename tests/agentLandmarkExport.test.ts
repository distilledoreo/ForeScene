import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import { createExportPlan } from '../src/engine/exportPlan';
import { resolveShotExportSettings } from '../src/engine/exportConfiguration';

describe('agent landmarks and export configuration', () => {
  it('creates, updates, links, and deletes landmarks without mutating the live project', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    actor.name = 'Linked Actor';
    project.scene.objects.push(actor);
    const beforeCount = project.landmarks.length;

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'landmark.create',
          ref: 'gate',
          landmark: {
            name: 'gate_marker',
            displayName: 'Gate Marker',
            position: [1, 1.5, 3],
            description: 'Continuity anchor',
          },
        },
        {
          op: 'landmark.linkObject',
          landmark: { ref: 'gate' },
          object: { id: actor.id },
        },
        {
          op: 'landmark.update',
          landmark: { ref: 'gate' },
          updates: { visible: false, promptCritical: true },
        },
      ],
    }, {
      project,
      workspace: 'reference',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(project.landmarks).toHaveLength(beforeCount);

    const created = prepared.prepared.nextProject.landmarks.find(
      (landmark) => landmark.name === 'gate_marker',
    );
    expect(created).toBeTruthy();
    expect(created?.linkedObjectId).toBe(actor.id);
    expect(created?.visible).toBe(false);
    expect(prepared.prepared.diff.landmarksCreated).toContain(created!.id);
    expect(prepared.prepared.summary.affectedLandmarkIds).toContain(created!.id);
    expect(prepared.prepared.summary.createdRefs.gate?.kind).toBe('landmark');

    const deleted = prepareAgentPlan({
      version: 1,
      commands: [
        { op: 'landmark.delete', landmark: { id: created!.id } },
      ],
    }, {
      project: prepared.prepared.nextProject,
      workspace: 'reference',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.prepared.nextProject.landmarks.some((landmark) => landmark.id === created!.id)).toBe(false);
    expect(deleted.prepared.diff.landmarksDeleted).toContain(created!.id);
  });

  it('patches scene defaults and shot overrides, then resets inheritance', () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    const beforeDefaults = { ...project.exportConfiguration!.defaults };

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'export.sceneDefaults.patch',
          patch: {
            includeViewport: true,
            includePrompt: false,
            width: 1280,
            height: 720,
          },
        },
        {
          op: 'export.shotOverrides.patch',
          shot: { id: shotId },
          patch: {
            includePanoCrop: true,
            includeMetadata: false,
          },
        },
      ],
    }, {
      project,
      workspace: 'export',
      selectedObjectIds: [],
      selectedShotId: shotId,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(project.exportConfiguration!.defaults.width).toBe(beforeDefaults.width);
    expect(prepared.prepared.diff.exportConfigurationChanged).toBe(true);

    const next = prepared.prepared.nextProject;
    expect(next.exportConfiguration!.defaults.includeViewport).toBe(true);
    expect(next.exportConfiguration!.defaults.includePrompt).toBe(false);
    expect(next.exportConfiguration!.defaults.width).toBe(1280);

    const shot = next.shots.find((item) => item.id === shotId)!;
    expect(shot.exportOverrides?.includePanoCrop).toBe(true);
    expect(shot.exportOverrides?.includeMetadata).toBe(false);
    const resolved = resolveShotExportSettings(next, shot);
    expect(resolved.includePanoCrop).toBe(true);
    expect(resolved.includeMetadata).toBe(false);
    expect(resolved.width).toBe(1280);

    const reset = prepareAgentPlan({
      version: 1,
      commands: [
        { op: 'export.shotOverrides.reset', shot: { id: shotId } },
      ],
    }, {
      project: next,
      workspace: 'export',
      selectedObjectIds: [],
      selectedShotId: shotId,
    });
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    const resetShot = reset.prepared.nextProject.shots.find((item) => item.id === shotId)!;
    expect(Object.keys(resetShot.exportOverrides ?? {})).toHaveLength(0);
    expect(resolveShotExportSettings(reset.prepared.nextProject, resetShot).includePanoCrop)
      .toBe(reset.prepared.nextProject.exportConfiguration!.defaults.includePanoCrop);

    // Export plan still builds against the patched project.
    const plan = createExportPlan(reset.prepared.nextProject, reset.prepared.nextProject.shots);
    expect(plan.summary.shotCount).toBe(reset.prepared.nextProject.shots.length);
  });

  it('copies and promotes shot export overrides', () => {
    const project = createDefaultProject();
    const first = project.shots[0]!;
    const second = {
      ...first,
      id: `${first.id}-copy`,
      shotNumber: '002',
      name: 'Camera 002',
      exportOverrides: {},
    };
    project.shots.push(second);

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'export.shotOverrides.patch',
          shot: { id: first.id },
          patch: { includeGrayboxPano: true, includeFullPano: false },
        },
        {
          op: 'export.shotOverrides.copy',
          fromShot: { id: first.id },
          toShots: [{ id: second.id }],
        },
        {
          op: 'export.shotOverrides.promote',
          shot: { id: first.id },
        },
      ],
    }, {
      project,
      workspace: 'export',
      selectedObjectIds: [],
      selectedShotId: first.id,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const next = prepared.prepared.nextProject;
    expect(next.exportConfiguration!.defaults.includeGrayboxPano).toBe(true);
    expect(next.exportConfiguration!.defaults.includeFullPano).toBe(false);
    const promotedSource = next.shots.find((shot) => shot.id === first.id)!;
    expect(Object.keys(promotedSource.exportOverrides ?? {})).toHaveLength(0);
  });
});
