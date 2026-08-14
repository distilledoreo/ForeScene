import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractAgentEnvelope, failureFromInvocation } from '../scripts/benchmark/agentCli';
import { buildCandidateBrief } from '../scripts/benchmark/brief';
import { collectBenchmarkRun, prepareBenchmarkRun } from '../scripts/benchmark/engine';
import { classifyCliFailure, isStopTheRun } from '../scripts/benchmark/failures';
import { findForbiddenCandidateFiles } from '../scripts/benchmark/forbidden';
import { enforceGitIdentity, unauthorizedRepoModifications } from '../scripts/benchmark/git';
import { incrementalMutationPlan, skippedLiveLifecycle } from '../scripts/benchmark/lifecycle';
import { parseBenchmarkSpec, loadBenchmarkSpec } from '../scripts/benchmark/spec';
import { BenchmarkClock, classifyCliPhase, emptyClassifyState, ingestCliLogs, summarizeBenchmarkTiming } from '../scripts/benchmark/timing';
import { extractAgentEnvelopes } from '../scripts/agent/runDocumentedCli';
import { gradeVisualDiagnostics } from '../scripts/benchmark/visualGrade';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('benchmark harness v3', () => {
  it('loads the three-shot spec without hard-coded camera coordinates', async () => {
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    expect(spec.id).toBe('three-shot');
    expect(spec.shots).toHaveLength(3);
    expect(spec.shots[1]?.requiredSubjects).toEqual(['lead', 'partner']);
    expect(spec.shots[2]?.intent).toBe('motion-required');
    expect(JSON.stringify(spec)).not.toMatch(/cameraMustBe|cameraPosition/);
  });

  it('adapts the frozen panorama-triad benchmark into a launchable V3 contract', async () => {
    const benchmarkRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-panorama-triad-'));
    await mkdir(path.join(benchmarkRoot, 'seed'), { recursive: true });
    await mkdir(path.join(benchmarkRoot, 'assets'), { recursive: true });
    await writeFile(path.join(benchmarkRoot, 'seed', 'what_im_fighting_for_panorama_triad_base.fsp'), 'neutral-package');
    await Promise.all([
      writeFile(path.join(benchmarkRoot, 'assets', 'Hand_Monster_v3.glb'), 'monster'),
      writeFile(path.join(benchmarkRoot, 'assets', 'Roman Joseph Amputated.glb'), 'j2'),
      writeFile(path.join(benchmarkRoot, 'assets', 'Roman Joseph Amputated.fsrig'), 'j2-rig'),
      writeFile(path.join(benchmarkRoot, 'assets', 'Roman Joseph Final.glb'), 'j3'),
      writeFile(path.join(benchmarkRoot, 'assets', 'Roman Joseph Final.fsrig'), 'j3-rig'),
    ]);
    const specPath = path.join(benchmarkRoot, 'shot-manifest.json');
    await writeFile(specPath, JSON.stringify({
      benchmarkId: 'music-video-v2-panorama-triad',
      version: '2.0.0',
      mode: 'create_three_shots_from_environment_only_base',
      baseProject: { expectedShotCount: 0, expectedSceneObjectCount: 22, expectedPanoRefCount: 4, expectedLandmarkCount: 28 },
      locations: {
        ruins: { anchorLandmark: 'ruins_platform', styledPanoId: 'pano_ruins' },
        corridor: { anchorLandmark: 'corridor_center', styledPanoId: null, note: 'No corridor panorama.' },
        armory: { anchorLandmark: 'armory_center', styledPanoId: 'pano_armory' },
      },
      shots: [
        {
          shotNumber: '01', name: 'H1 newborn hand creature', kind: 'static_creature_composition', location: 'ruins', linkedPanoId: 'pano_ruins',
          assets: [{ file: 'Hand_Monster_v3.glb', importAs: 'ordinary_model' }], requirements: ['Five finger limbs and eye stalk.'], deliverable: 'creature-final.png',
        },
        {
          shotNumber: '02', name: 'Sprint chase toward armory', kind: 'three_second_motion', location: 'corridor', linkedPanoId: null,
          assets: [{ file: 'Roman Joseph Amputated.glb', rigFile: 'Roman Joseph Amputated.fsrig', importAs: 'saved_rig_character' }, { file: 'Hand_Monster_v3.glb', importAs: 'ordinary_model' }],
          requirements: ['Three-second chase at t=0 and t=3.'], deliverables: ['chase-start.png', 'chase-mid.png', 'chase-end.png', 'chase-motion.mp4'],
        },
        {
          shotNumber: '03', name: 'J3 battle-ready stance', kind: 'static_saved_rig_character_pose', location: 'armory', linkedPanoId: 'pano_armory',
          assets: [{ file: 'Roman Joseph Final.glb', rigFile: 'Roman Joseph Final.fsrig', importAs: 'saved_rig_character' }], requirements: ['Shield and wrist blade.'], deliverable: 'fighter-final.png',
        },
      ],
      standardDeliverables: ['creature-final.png', 'chase-start.png', 'chase-mid.png', 'chase-end.png', 'chase-motion.mp4', 'fighter-final.png', 'contact-sheet.png', 'final-project.fsp', 'run-report.json', 'validation-report.json'],
    }));

    const spec = await loadBenchmarkSpec(specPath);
    expect(spec.id).toBe('music-video-v2-panorama-triad');
    expect(spec.operatingMode).toBe('existing-project-refinement');
    expect(spec.resetAuthorized).toBe(false);
    expect(spec.repairBudget).toBe(2);
    expect(spec.basePackage).toBe(path.join(benchmarkRoot, 'seed', 'what_im_fighting_for_panorama_triad_base.fsp'));
    expect(spec.requiredArtifacts).toContain('final-project.fsp');
    expect(spec.shots.map((shot) => shot.shotNumber)).toEqual(['01', '02', '03']);
    expect(spec.shots[1]?.intent).toBe('motion-required');
    expect(spec.productionManifest?.project.operatingMode).toBe('existing-project-refinement');
    const chaseMotion = spec.productionManifest?.shots[1]?.motion;
    expect(chaseMotion).toMatchObject({
      durationSeconds: 3,
      renderControlVideo: true,
      keyframes: [
        { timeSeconds: 0 },
        { timeSeconds: 1.5 },
        { timeSeconds: 3 },
      ],
    });
    const chaseStart = chaseMotion?.keyframes[0]?.staging ?? [];
    const chaseEnd = chaseMotion?.keyframes.at(-1)?.staging ?? [];
    for (const subject of ['joseph-amputated', 'hand-monster']) {
      expect(chaseStart.find((item) => item.subject === subject)?.transform?.position)
        .not.toEqual(chaseEnd.find((item) => item.subject === subject)?.transform?.position);
    }
    expect(spec.productionManifest?.assets?.find((asset) => asset.id === 'hand-monster')).toMatchObject({
      type: 'imported_model',
      importMode: 'ordinary_model',
      semanticRole: 'subject',
    });
    expect(spec.productionManifest?.cast).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'joseph-amputated', type: 'imported_character', rigMode: 'saved-rig' }),
      expect.objectContaining({ id: 'joseph-final', type: 'imported_character', rigMode: 'saved-rig' }),
    ]));

    const runRoot = path.join(benchmarkRoot, 'runs', 'MV3-Benchmark-02');
    const prepared = await prepareBenchmarkRun({
      spec,
      specPath,
      runRoot,
      enforceRepositoryState: false,
    });
    expect(prepared.failure).toBeUndefined();
    const brief = JSON.parse(await readFile(prepared.layout.briefPath, 'utf8')) as ReturnType<typeof buildCandidateBrief>;
    expect(brief.projectPackage).toBe(path.join(prepared.layout.projectDir, 'what_im_fighting_for_panorama_triad_base.fsp'));
    expect(brief.requiredArtifacts).toContain('validation-report.json');
    const production = JSON.parse(await readFile(brief.productionManifest!, 'utf8')) as typeof spec.productionManifest;
    expect(production?.assets?.find((asset) => asset.id === 'hand-monster')?.type).toBe('imported_model');
  });

  it('rejects specs that encode a benchmark camera solution', () => {
    expect(() => parseBenchmarkSpec({
      version: 1,
      id: 'bad',
      name: 'Bad',
      qualityMode: 'rapid-previs',
      operatingMode: 'greenfield',
      writeAuthorized: true,
      resetAuthorized: true,
      repairBudget: 0,
      requiredCliCapabilities: [],
      shots: [{
        id: 's020',
        shotNumber: '020',
        name: 'Cheat',
        description: 'Do not do this',
        intent: 'still',
        requiredSubjects: ['lead'],
        stillArtifacts: ['020.png'],
        cameraMustBe: [0.55, 0.48, -3.15],
      }],
    })).toThrow(/must not hard-code camera coordinates/);
  });

  it('classifies ForeScene timeouts as infrastructure failures that stop the run', () => {
    const failure = classifyCliFailure({
      operation: 'character.importSavedRig',
      message: 'character.import → timeout',
    });
    expect(failure.class).toBe('INFRASTRUCTURE_FAILURE');
    expect(failure.operation).toBe('character.importSavedRig');
    expect(failure.code).toBeUndefined();
    expect(isStopTheRun(failure)).toBe(true);
  });

  it('classifies persist/export/rehydrate/package mismatches as application defects, not model failures', () => {
    const persist = classifyCliFailure({
      operation: 'project.save',
      message: 'Persist/rehydrate mismatch: shot shot_b panoramaBinding explicit_null → linked',
    });
    expect(persist.class).toBe('INFRASTRUCTURE_FAILURE');
    expect(persist.code).toBe('application_defect');
    expect(persist.class).not.toBe('MODEL_FAILURE');

    const backup = classifyCliFailure({
      operation: 'project.backup',
      code: 'application_defect',
      message: 'Backup package identity mismatch vs live project: model binary mesh is missing',
    });
    expect(backup.class).toBe('INFRASTRUCTURE_FAILURE');
    expect(backup.code).toBe('application_defect');

    const disconnect = classifyCliFailure({
      operation: 'project.inspect',
      message: 'orphaned chromium / browser closed during inspect',
    });
    expect(disconnect.class).toBe('INFRASTRUCTURE_FAILURE');
    expect(disconnect.code).toBeUndefined();
    expect(isStopTheRun(persist)).toBe(true);
  });

  it('flags candidate-created glue scripts and window.foreScene helpers', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-forbidden-'));
    await writeFile(path.join(workDir, 'open-package.ts'), 'export const x = 1;\n');
    await mkdir(path.join(workDir, 'helpers'), { recursive: true });
    await writeFile(path.join(workDir, 'helpers', 'render.ts'), 'window.foreScene.renderShotFrame({ shotId: "x" });\n');
    const hits = await findForbiddenCandidateFiles(workDir);
    expect(hits.map((hit) => hit.relativePath).sort()).toEqual(['helpers/render.ts', 'open-package.ts']);
  });

  it('writes a benchmark brief and technically validates required artifacts', async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-run-'));
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    const prepared = await prepareBenchmarkRun({
      spec,
      specPath: path.join(repoRoot, 'benchmarks/three-shot.json'),
      runRoot,
      url: 'http://127.0.0.1:3000',
      enforceRepositoryState: false,
    });
    expect(prepared.failure).toBeUndefined();
    const brief = JSON.parse(await readFile(prepared.layout.briefPath, 'utf8')) as ReturnType<typeof buildCandidateBrief>;
    expect(brief.mode).toBe('benchmark');
    expect(brief.writeAuthorized).toBe(true);
    expect(brief.resetAuthorized).toBe(true);
    expect(brief.repairBudget).toBe(2);
    expect(brief.cliOnly).toBe(true);
    expect(brief.forbidWindowForeScene).toBe(true);
    expect(brief.repoRoot).toBe(repoRoot);
    expect(prepared.layout.recoveryProfileDir).toContain('profile-recovery');

    await writeFile(path.join(prepared.layout.artifactDir, '010.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '020.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '030-start.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '030-mid.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '030-end.png'), 'png');
    const mp4 = Buffer.alloc(32);
    mp4.write('ftyp', 4, 'ascii');
    await writeFile(path.join(prepared.layout.artifactDir, '030.mp4'), mp4);

    const collected = await collectBenchmarkRun({ spec, layout: prepared.layout, enforceRepositoryState: false });
    expect(collected.failure).toBeUndefined();
    expect(collected.validation.ok).toBe(true);
  });

  it('treats missing stills as a model failure, not a harness failure', async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-missing-'));
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    const prepared = await prepareBenchmarkRun({
      spec,
      specPath: path.join(repoRoot, 'benchmarks/three-shot.json'),
      runRoot,
      enforceRepositoryState: false,
    });
    const collected = await collectBenchmarkRun({ spec, layout: prepared.layout, enforceRepositoryState: false });
    expect(collected.validation.ok).toBe(false);
    expect(collected.failure?.class).toBe('MODEL_FAILURE');
  });

  it('records skipped live lifecycle without opening a browser', () => {
    const records = skippedLiveLifecycle('unit test');
    expect(records.map((record) => record.id)).toEqual(['cold-open', 'incremental', 'recovery']);
    expect(records.every((record) => record.status === 'skipped')).toBe(true);
  });

  it('parses Agent CLI envelopes from pretty-printed stdout', () => {
    const envelope = extractAgentEnvelope(`noise\n${JSON.stringify({
      ok: true,
      operation: 'project.inspect',
      durationMs: 12,
      warnings: [],
      result: { ok: true },
    }, null, 2)}\n`);
    expect(envelope?.operation).toBe('project.inspect');
    expect(envelope?.ok).toBe(true);
  });

  it('records harness timing phases', () => {
    const clock = new BenchmarkClock();
    clock.start('prepare');
    clock.stop('prepare');
    const phases = clock.snapshot();
    expect(phases[0]?.id).toBe('prepare');
    expect(phases[0]?.owner).toBe('harness');
    expect(typeof phases[0]?.durationMs).toBe('number');
  });

  it('classifies CLI envelopes into E2E phases and does not treat missing cache as hits', async () => {
    const state = emptyClassifyState();
    expect(classifyCliPhase('render.frame.projected', { command: 'frame', appearance: 'projected' }, state).id).toBe('still-render.projected');
    expect(classifyCliPhase('character.import', { command: 'import-character', rigMode: 'saved-rig' }, emptyClassifyState()).id).toBe('saved-rig-import');
    const afterPreflight = emptyClassifyState();
    afterPreflight.visualPreflightCount = 1;
    expect(classifyCliPhase('project.applyPlan', { command: 'apply' }, afterPreflight).id).toBe('repair-pass-1');

    const stdout = `${JSON.stringify({
      ok: true,
      operation: 'render.frame.clay',
      durationMs: 40,
      warnings: [],
      result: { ok: true },
    })}\n${JSON.stringify({
      ok: true,
      operation: 'render.video.clay',
      durationMs: 90,
      warnings: [],
      result: { ok: true, timing: { encodeMs: 12 } },
    })}\n`;
    const stderr = '[agent] command=frame appearance=clay\n[agent] chromium-launch profile=/tmp/p recovered=0\n[agent] command=video appearance=clay\n';
    expect(extractAgentEnvelopes(stdout)).toHaveLength(2);

    const clock = new BenchmarkClock();
    clock.start('run');
    clock.start('invoke-candidate', 'candidate');
    ingestCliLogs(clock, { stdout, stderr, parentId: 'invoke-candidate' });
    clock.stop('invoke-candidate');
    clock.stop('run');
    const summary = summarizeBenchmarkTiming(clock.snapshot());
    expect(summary.policy.soakGateTotalsAreNotE2EPhases).toBe(true);
    expect(summary.retries).toBe(0);
    expect(summary.cache.present).toBe(false);
    expect(summary.chromiumLaunches).toBe(1);
    expect(summary.chromiumLaunchSource).toBe('logged');
    expect(summary.byPhaseId['still-render.clay']?.count).toBe(1);
    expect(summary.byPhaseId['motion-video']?.count).toBe(1);
    expect(summary.byPhaseId['motion-encode']?.durationMs).toBe(12);
    expect(summary.candidateWallMs).toBeGreaterThanOrEqual(0);
    expect(summary.foresceneToolMs).toBeGreaterThanOrEqual(40 + 90);
    expect(summary.operationCount).toBeGreaterThanOrEqual(2);
  });

  it('prepare-only CLI finishes clean from an external cwd via FORESCENE_REPO_ROOT', () => {
    const runRoot = path.join(os.tmpdir(), `forescene-bench-cli-${Date.now()}`);
    const npmExec = process.env.npm_execpath;
    const output = execFileSync(
      npmExec ? process.execPath : 'npm',
      npmExec
        ? [npmExec, '--prefix', repoRoot, 'run', 'benchmark:run', '--', '--spec', 'benchmarks/three-shot.json', '--run-root', runRoot, '--prepare-only']
        : ['--prefix', repoRoot, 'run', 'benchmark:run', '--', '--spec', 'benchmarks/three-shot.json', '--run-root', runRoot, '--prepare-only'],
      {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          FORESCENE_REPO_ROOT: repoRoot,
          FORESCENE_BENCHMARK_ALLOW_DIRTY: '1',
        },
      },
    );
    const parsed = JSON.parse(output.slice(output.indexOf('{'))) as {
      ok: boolean;
      specId: string;
      runRoot: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.specId).toBe('three-shot');
    expect(parsed.runRoot).toBe(runRoot);
  }, 30_000);

  it('grades visual-preflight metrics without requiring camera coordinates', async () => {
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    const passing = gradeVisualDiagnostics(spec, {
      result: {
        visualPreflight: [
          {
            shotId: 's010',
            ok: true,
            subjects: [{ objectId: 'obj_lead_1', name: 'Lead' }],
            presentSubjectIds: ['obj_lead_1'],
            missingSubjectIds: [],
            checks: [
              { id: 'camera_direction', status: 'passed' },
              { id: 'subject_visibility', status: 'passed' },
              { id: 'framing_coverage', status: 'passed' },
            ],
          },
          {
            shotId: 's020',
            ok: true,
            subjects: [
              { objectId: 'obj_lead_1', name: 'Lead' },
              { objectId: 'obj_partner_1', name: 'Partner' },
            ],
            presentSubjectIds: ['obj_lead_1', 'obj_partner_1'],
            missingSubjectIds: [],
            checks: [
              { id: 'camera_direction', status: 'passed' },
              { id: 'subject_visibility', status: 'passed' },
              { id: 'framing_coverage', status: 'passed' },
            ],
          },
          {
            shotId: 's030',
            ok: true,
            subjects: [{ objectId: 'obj_lead_1', name: 'Lead' }],
            presentSubjectIds: ['obj_lead_1'],
            missingSubjectIds: [],
            checks: [
              { id: 'camera_direction', status: 'passed' },
              { id: 'subject_visibility', status: 'passed' },
              { id: 'framing_coverage', status: 'passed' },
              { id: 'motion_continuity', status: 'passed' },
            ],
            samples: [{ timeSeconds: 0, label: 'start' }, { timeSeconds: 1, label: 'mid' }, { timeSeconds: 2, label: 'end' }],
          },
        ],
      },
    });
    expect(passing.ok).toBe(true);
    expect(JSON.stringify(passing)).not.toMatch(/cameraMustBe|cameraPosition/);

    const implicit = gradeVisualDiagnostics(spec, {
      result: {
        visualPreflight: [{
          shotId: 's010',
          missingSubjectIds: [],
          checks: [],
        }],
      },
    });
    expect(implicit.ok).toBe(false);
    expect(implicit.checks.some((check) => check.status === 'not_verified')).toBe(true);

    const failing = gradeVisualDiagnostics(spec, {
      result: {
        visualPreflight: [{
          shotId: 's020',
          environmentOnly: true,
          requestedSubjectIds: [],
          missingSubjectIds: ['lead', 'partner'],
          checks: [{ id: 'camera_direction', status: 'failed', message: 'not aimed at subjects' }],
        }],
      },
    });
    expect(failing.ok).toBe(false);
    expect(failing.checks.some((check) => check.layer === 'subject' && !check.ok)).toBe(true);
  });

  it('fails closed on an unexpected commit or dirty tree', () => {
    expect(enforceGitIdentity({
      commit: 'aaa',
      expectedCommit: 'bbb',
      expectedCommitIsAncestor: false,
      dirty: false,
      porcelain: '',
      allowDirty: false,
    })?.class).toBe('ENVIRONMENT_FAILURE');
    expect(enforceGitIdentity({
      commit: 'descendant',
      expectedCommit: 'stabilization',
      expectedCommitIsAncestor: true,
      dirty: false,
      porcelain: '',
      allowDirty: false,
    })).toBeUndefined();
    expect(enforceGitIdentity({
      commit: 'aaa',
      expectedCommit: 'aaa',
      dirty: true,
      porcelain: ' M src/App.tsx',
      allowDirty: false,
    })?.message).toMatch(/dirty/);
    expect(enforceGitIdentity({
      commit: 'aaa',
      expectedCommit: 'aaa',
      dirty: true,
      porcelain: ' M src/App.tsx',
      allowDirty: true,
    })).toBeUndefined();
  });

  it('reports unauthorized source edits after the candidate', () => {
    const before = {
      commit: 'aaa',
      expectedCommit: 'aaa',
      dirty: false,
      porcelain: '',
      allowDirty: false,
    };
    expect(unauthorizedRepoModifications(before, {
      ...before,
      dirty: true,
      porcelain: ' M scripts/benchmark/run.ts',
    })?.message).toMatch(/Unauthorized/);
  });

  it('requires incremental lifecycle to be a real mutate/save plan', () => {
    const plan = incrementalMutationPlan();
    expect(plan.commands[0]?.op).toBe('project.updateInfo');
  });

  it('classifies CLI timeouts as infrastructure failures', () => {
    const failure = failureFromInvocation({
      code: 1,
      stdout: '',
      stderr: 'npm run agent:video exceeded 180000ms',
    }, 'render.video');
    expect(failure.class).toBe('INFRASTRUCTURE_FAILURE');
    expect(isStopTheRun(failure)).toBe(true);
  });
});
