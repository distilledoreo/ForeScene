import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAgentCliArgs } from '../scripts/agent/cliArgs';
import { describeAgentCliCommand } from '../scripts/agent/cliCommands';
import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';
import { inspectShotVisualPreflight } from '../src/engine/agent/visualPreflight';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { buildScene, disposeScene } from '../src/engine/sceneObjects';
import { normalizeProjectedStyleSettings } from '../src/domain/defaults';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { visualValidationProject } from './fixtures/visualValidationProject';

afterEach(() => useAgentControlStore.setState({ controlMode: 'off' }));

describe('agent visual validation controls', () => {
  it.each(['verify', 'visual-preflight'])('parses and advertises %s subject, environment and render selection', (command) => {
    const args = parseAgentCliArgs([command, '--subjects', 'a,b', '--subjects', 'b,c',
      '--environment-objects', 'wall,rubble', '--appearance', 'projected']);
    expect(args.subjectIds).toEqual(['a', 'b', 'c']);
    expect(args.environmentObjectIds).toEqual(['wall', 'rubble']);
    expect(args.appearance).toBe('projected');
    expect(describeAgentCliCommand(command)?.optional.join(' ')).toMatch(/--subjects.*--environment-objects.*--appearance/);
  });

  it.each([
    ['verify', '--subjects'], ['verify', '--subjects', ''], ['verify', '--subjects', 'a,'],
    ['visual-preflight', '--environment-objects', '--appearance', 'clay'],
    ['verify', '--appearance', 'invalid'], ['frame', '--subjects', 'a'],
    ['verify', '--appearance'], ['visual-preflight', '--mode'],
    ['verify', '--mode', 'projected', '--appearance', 'clay'],
  ])('rejects malformed visual selection %j', (...args) => {
    expect(() => parseAgentCliArgs(args)).toThrow();
  });

  it('accepts the render command mode alias without silently validating clay', () => {
    expect(parseAgentCliArgs(['verify', '--mode', 'projected']).appearance).toBe('projected');
  });

  it('forwards controls through collection and keeps them read-only', () => {
    const { project, shot, subject, dressing } = visualValidationProject();
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectStore.setState({ project });
    const before = structuredClone(project);
    const api = createForeSceneBrowserApi();
    const collected = api.collectVisualPreflightValidation({ shotIds: [shot.id],
      subjectIds: [subject.id], environmentObjectIds: [dressing.id], appearance: 'projected' });
    expect(collected.visualPreflight?.[0]).toMatchObject({ ok: true, appearance: 'projected',
      requestedSubjectIds: [subject.id], environmentObjectIds: [dressing.id] });
    expect(useProjectStore.getState().project).toEqual(before);
  });

  it('matches actual scene membership for projected set proxies and clay occlusion', () => {
    const { project, shot, subject, dressing, wall, floor } = visualValidationProject();
    const texture = new THREE.Texture();
    const scene = buildScene(project, { appearance: 'projected', projected: {
      texture, origin: [0, 1.6, 0], rotation: [0, 0, 0],
      settings: normalizeProjectedStyleSettings(project.settings.projectedStyle),
    } });
    try {
      const ids = scene.children.map((node) => node.userData.sceneObjectId);
      expect(ids).not.toContain(wall.id);
      expect(ids).toEqual(expect.arrayContaining([subject.id, dressing.id, floor.id]));
      const input = { project, shotId: shot.id, subjectIds: [subject.id], environmentObjectIds: [dressing.id] };
      const projected = inspectShotVisualPreflight({ ...input, appearance: 'projected' });
      expect(projected.ok).toBe(true);
      const clay = inspectShotVisualPreflight({ ...input, appearance: 'clay' });
      expect(clay.ok).toBe(false);
      expect(clay.subjects[0]?.occlusionRatio).toBe(1);
      expect(projected.subjects[0]?.occlusionRatio).toBe(0);
      // Labeling a real occluder as environment never makes it transparent.
      expect(inspectShotVisualPreflight({ ...input, environmentObjectIds: [dressing.id, wall.id] }).ok).toBe(false);
    } finally { disposeScene(scene); texture.dispose(); }
  });

  it('retains unclassified visible geometry, even outside the camera', () => {
    const { project, shot, subject, dressing } = visualValidationProject();
    const result = inspectShotVisualPreflight({ project, shotId: shot.id, subjectIds: [subject.id], appearance: 'projected' });
    expect(result.gateStatus).toBe('failed');
    expect(result.unresolvedVisibleObjectIds).toEqual([dressing.id]);
    expect(result.diagnostics.some((d) => d.message.includes('--environment-objects'))).toBe(true);
  });

  it('keeps a wall staged as a prop visible and occluding in projected mode', () => {
    const { project, shot, subject, dressing, wall } = visualValidationProject();
    wall.stagingRole = 'prop';
    const result = inspectShotVisualPreflight({ project, shotId: shot.id, subjectIds: [subject.id],
      environmentObjectIds: [dressing.id, wall.id], appearance: 'projected' });
    expect(result.gateStatus).toBe('failed');
    expect(result.subjects[0]?.occlusionRatio).toBe(1);
  });

  it.each(['missing', 'hidden', 'omitted-proxy'] as const)('fails required %s subjects despite environment classification', (variant) => {
    const { project, shot, subject, dressing, wall } = visualValidationProject();
    const required = variant === 'missing' ? 'absent-id' : variant === 'omitted-proxy' ? wall.id : subject.id;
    if (variant === 'hidden') shot.objectOverrides = { [subject.id]: { visible: false } };
    const result = inspectShotVisualPreflight({ project, shotId: shot.id, subjectIds: [required],
      environmentObjectIds: [subject.id, dressing.id, wall.id], appearance: 'projected' });
    expect(result.gateStatus).toBe('failed');
    expect(result.missingSubjectIds).toContain(required);
  });

  it.each([0, 1.2])('detects incorrect center height %s and preserves the supported grounding correction', (y) => {
    const { project, shot, subject, dressing } = visualValidationProject();
    subject.transform.position[1] = y;
    const input = { shotId: shot.id, subjectIds: [subject.id], environmentObjectIds: [dressing.id], appearance: 'projected' as const };
    const failed = inspectShotVisualPreflight({ project, ...input });
    expect(failed.checks.find((check) => check.id === 'ground_contact')?.status).toBe('failed');
    const corrected = prepareAgentPlan({ version: 1, commands: [{ op: 'shot.stageObject',
      shot: { id: shot.id }, object: { id: subject.id }, transform: {
        ...subject.transform, position: [0, 0.5, 0],
      } }] }, { project, workspace: 'shots', selectedObjectIds: [] });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const reopened = parseProject(serializeProject(corrected.prepared.nextProject));
    expect(inspectShotVisualPreflight({ project: reopened, ...input }).ok).toBe(true);
    expect(reopened.shots[0]?.objectOverrides?.[subject.id]?.transform?.position[1]).toBe(0.5);
  });

  it('fails unknown environment IDs and unresolved projected panoramas', () => {
    const { project, shot, subject } = visualValidationProject();
    const input = { project, shotId: shot.id, subjectIds: [subject.id] };
    expect(inspectShotVisualPreflight({ ...input, environmentObjectIds: ['typo'] }).diagnostics[0]?.code).toBe('environment_object_missing');
    shot.linkedPanoId = null;
    const missing = inspectShotVisualPreflight({ ...input, appearance: 'projected' });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics[0]?.code).toBe('projected_panorama_missing');
  });
});
