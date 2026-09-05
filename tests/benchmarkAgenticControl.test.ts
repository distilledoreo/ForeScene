import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadAgenticControlContract } from '../scripts/benchmark/agenticControlContract';
import {
  capabilitiesExportPackage,
  inspectSnapshotFromInspectPayload,
  shotIdSetEqual,
} from '../scripts/benchmark/agenticControlInspect';
import {
  parseAgenticControlCandidateReport,
  requireCleanRepositoryForScoring,
  scoreAgenticControlCandidateReport,
  scoreAgenticControlRun,
} from '../scripts/benchmark/agenticControlScorer';
import type { AgenticControlContract } from '../scripts/benchmark/agenticControlContract';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repoRoot, 'benchmarks/agentic-control-v1/contract.json');
const contractV2Path = path.join(repoRoot, 'benchmarks/agentic-control-v2/contract.json');
const contractV3Path = path.join(repoRoot, 'benchmarks/agentic-control-v3/contract.json');
const contractV4Path = path.join(repoRoot, 'benchmarks/agentic-control-v4/contract.json');

function baseReport() {
  return {
    runner: 'cheap-agent' as const,
    invocations: [
      { step: 'capabilities', npmScript: 'capabilities', exitCode: 0, envelopeOk: true },
      { step: 'open-seed', npmScript: 'open', exitCode: 0, envelopeOk: true },
      { step: 'inspect-before', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
      { step: 'render-clay', npmScript: 'frame', exitCode: 0, envelopeOk: true },
      { step: 'save', npmScript: 'save', exitCode: 0, envelopeOk: true },
      { step: 'reopen', npmScript: 'open', exitCode: 0, envelopeOk: true },
      { step: 'inspect-after', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
      { step: 'package', npmScript: 'package', exitCode: 0, envelopeOk: true },
    ],
    capabilities: { exportPackage: true },
    inspectBefore: {
      projectId: 'project_fixture',
      shotIds: ['shot_a', 'shot_b'],
      castCount: 1,
      assetCount: 0,
    },
    inspectAfter: {
      projectId: 'project_fixture',
      shotIds: ['shot_a', 'shot_b'],
      castCount: 1,
      assetCount: 0,
    },
    package: { status: 'completed' as const },
  };
}

describe('ForeScene Benchmark agentic-control-v1', () => {
  it('loads the lifecycle-control contract', async () => {
    const loaded = await loadAgenticControlContract(contractPath);
    expect(loaded.contract.id).toBe('agentic-control-v1');
    expect(loaded.contract.family).toBe('lifecycle-control');
    if (loaded.contract.family === 'lifecycle-control' || loaded.contract.family === 'operator-intent') {
      expect(loaded.contract.render.shotSelector).toBe('first');
      expect(loaded.contract.render.mode).toBe('clay');
    }
    expect(loaded.contract.artifacts.savedProject).toBe('project.fsp');
    expect(loaded.seedPath).toContain('lifecycle-temple.fsp');
  });

  it('loads the operator-intent v2 contract', async () => {
    const loaded = await loadAgenticControlContract(contractV2Path);
    expect(loaded.contract.id).toBe('agentic-control-v2');
    expect(loaded.contract.family).toBe('operator-intent');
    expect(loaded.seedPath).toContain('operator-corridor.fsp');
  });

  it('loads the import-idempotency v3 contract', async () => {
    const loaded = await loadAgenticControlContract(contractV3Path);
    expect(loaded.contract.id).toBe('agentic-control-v3');
    expect(loaded.contract.family).toBe('import-idempotency');
    expect(loaded.seedPath).toContain('import-empty.fsp');
    expect(loaded.importFixturePath).toContain('ordinary-cube.glb');
    if (loaded.contract.family === 'import-idempotency') {
      expect(loaded.contract.importModel.runRelativePath).toBe('ordinary-cube.glb');
    }
  });

  it('loads the fresh-profile-recovery v4 contract', async () => {
    const loaded = await loadAgenticControlContract(contractV4Path);
    expect(loaded.contract.id).toBe('agentic-control-v4');
    expect(loaded.contract.family).toBe('fresh-profile-recovery');
    expect(loaded.seedPath).toContain('operator-corridor.fsp');
  });

  it('treats repository.clean as a warning unless FORESCENE_BENCHMARK_REQUIRE_CLEAN=1', () => {
    const contract = {
      version: 1 as const,
      id: 'agentic-control-v1' as const,
      family: 'lifecycle-control' as const,
      description: 'fixture',
      seedPackage: 'seed/lifecycle-temple.fsp',
      render: { shotSelector: 'first', mode: 'clay' as const, artifact: 'work/artifacts/clay-frame.png' },
      artifacts: {
        savedProject: 'project.fsp',
        candidateReport: 'work/candidate-report.json',
      },
      thresholds: { minBytes: 1024 },
      scoring: { requirePackageWhenCapable: true, checkRepositoryDrift: true },
    } satisfies AgenticControlContract;
    const report = parseAgenticControlCandidateReport(baseReport());
    const gitBefore = {
      commit: 'abc123',
      dirty: false,
      porcelain: '',
      expectedCommit: 'abc123',
      allowDirty: false,
      contentFingerprint: 'before-fingerprint',
    };
    const gitAfter = {
      ...gitBefore,
      dirty: true,
      porcelain: ' M scripts/benchmark/agenticControlScorer.ts',
      contentFingerprint: 'after-fingerprint',
    };

    const previous = process.env.FORESCENE_BENCHMARK_REQUIRE_CLEAN;
    delete process.env.FORESCENE_BENCHMARK_REQUIRE_CLEAN;
    const warningOnly = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report,
      gitBefore,
      gitAfter,
    });
    expect(warningOnly.checks.find((check) => check.id === 'repository.clean')?.ok).toBe(false);
    expect(warningOnly.technicalPass).toBe(true);
    expect(requireCleanRepositoryForScoring()).toBe(false);

    process.env.FORESCENE_BENCHMARK_REQUIRE_CLEAN = '1';
    const strict = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report,
      gitBefore,
      gitAfter,
    });
    expect(strict.checks.find((check) => check.id === 'repository.clean')?.ok).toBe(false);
    expect(strict.technicalPass).toBe(false);
    expect(requireCleanRepositoryForScoring()).toBe(true);

    if (previous === undefined) delete process.env.FORESCENE_BENCHMARK_REQUIRE_CLEAN;
    else process.env.FORESCENE_BENCHMARK_REQUIRE_CLEAN = previous;
  });

  it('parses inspect snapshots and capability export flags', () => {
    const payload = {
      project: { id: 'project_abc' },
      shots: [{ id: 'shot_1' }, { id: 'shot_2' }],
      objects: [
        { id: 'obj_1', type: 'human_dummy' },
        { id: 'obj_2', type: 'floor' },
      ],
      document: { assets: { assets: { asset_1: { id: 'asset_1' } } } },
    };
    expect(inspectSnapshotFromInspectPayload(payload)).toEqual({
      projectId: 'project_abc',
      shotIds: ['shot_1', 'shot_2'],
      castCount: 1,
      assetCount: 1,
      importedModelCount: 0,
    });
    expect(capabilitiesExportPackage({
      capabilities: { 'export.package': true },
    })).toBe(true);
    expect(shotIdSetEqual(['b', 'a'], ['a', 'b'])).toBe(true);
  });

  it('preserves inspect shot order for first-shot selection', () => {
    const payload = {
      project: { id: 'project_abc' },
      shots: [{ id: 'shot_z_last_lex' }, { id: 'shot_a_first_doc' }],
      objects: [],
    };
    expect(inspectSnapshotFromInspectPayload(payload)?.shotIds).toEqual([
      'shot_z_last_lex',
      'shot_a_first_doc',
    ]);
  });

  it('scores a structurally valid candidate report as technical pass', () => {
    const loaded = {
      contract: {
        version: 1 as const,
        id: 'agentic-control-v1' as const,
        family: 'lifecycle-control' as const,
        description: 'fixture',
        seedPackage: 'seed/lifecycle-temple.fsp',
        render: { shotSelector: 'first', mode: 'clay' as const, artifact: 'work/artifacts/clay-frame.png' },
        artifacts: {
          savedProject: 'project.fsp',
          candidateReport: 'work/candidate-report.json',
          packageExport: 'work/artifacts/export-package.zip',
        },
        thresholds: { minBytes: 1024 },
        scoring: { requirePackageWhenCapable: true, checkRepositoryDrift: false },
      } satisfies AgenticControlContract,
      contractPath,
      seedPath: '/tmp/seed.fsp',
    };
    const report = parseAgenticControlCandidateReport(baseReport());
    const scored = scoreAgenticControlCandidateReport({
      contract: loaded.contract,
      runRoot: '/tmp/run',
      report,
    });
    expect(scored.technicalPass).toBe(true);
    expect(scored.checks.every((check) => check.ok)).toBe(true);
  });

  it('fails when cast count increases or a required invocation is missing', () => {
    const contract = {
      version: 1 as const,
      id: 'agentic-control-v1' as const,
      family: 'lifecycle-control' as const,
      description: 'fixture',
      seedPackage: 'seed/lifecycle-temple.fsp',
      render: { shotSelector: 'first', mode: 'clay' as const, artifact: 'work/artifacts/clay-frame.png' },
      artifacts: {
        savedProject: 'project.fsp',
        candidateReport: 'work/candidate-report.json',
      },
      thresholds: { minBytes: 1024 },
      scoring: { requirePackageWhenCapable: true, checkRepositoryDrift: false },
    } satisfies AgenticControlContract;

    const increasedCast = {
      ...baseReport(),
      inspectAfter: { ...baseReport().inspectAfter, castCount: 2 },
    };
    const castFail = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report: increasedCast,
    });
    expect(castFail.technicalPass).toBe(false);
    expect(castFail.checks.find((check) => check.id === 'continuity.castCount')?.ok).toBe(false);

    const missingSave = {
      ...baseReport(),
      invocations: baseReport().invocations.filter((entry) => entry.step !== 'save'),
      capabilities: { exportPackage: false },
      package: { status: 'skipped' as const, reason: 'export.package unavailable in capabilities' },
    };
    const saveFail = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report: missingSave,
    });
    expect(saveFail.technicalPass).toBe(false);
    expect(saveFail.checks.find((check) => check.id === 'invocation.save')?.ok).toBe(false);

    const missingEnvelope = {
      ...baseReport(),
      invocations: baseReport().invocations.map((entry) => (
        entry.step === 'save' ? { ...entry, envelopeOk: undefined } : entry
      )),
    };
    const envelopeFail = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report: missingEnvelope,
    });
    expect(envelopeFail.technicalPass).toBe(false);
    expect(envelopeFail.checks.find((check) => check.id === 'invocation.save')?.ok).toBe(false);
  });

  it('scores import-idempotency candidate reports', () => {
    const contract = {
      version: 1 as const,
      id: 'agentic-control-v3' as const,
      family: 'import-idempotency' as const,
      description: 'fixture',
      seedPackage: 'seed/import-empty.fsp',
      importModel: {
        fixtureSource: 'tests/fixtures/ordinary-cube.glb',
        runRelativePath: 'ordinary-cube.glb',
      },
      artifacts: {
        savedProject: 'project.fsp',
        candidateReport: 'work/candidate-report.json',
      },
      thresholds: { minBytes: 1024 },
      scoring: { checkRepositoryDrift: false },
    };
    const seed = {
      projectId: 'project_fixture',
      shotIds: ['shot_a'],
      castCount: 0,
      assetCount: 0,
      importedModelCount: 0,
    };
    const afterFirst = { ...seed, assetCount: 1, importedModelCount: 1 };
    const report = {
      runner: 'cheap-agent' as const,
      invocations: [
        { step: 'open-seed', npmScript: 'open', exitCode: 0, envelopeOk: true },
        { step: 'inspect-seed', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
        { step: 'import-first', npmScript: 'import-model', exitCode: 0, envelopeOk: true },
        { step: 'inspect-after-first', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
        { step: 'import-second', npmScript: 'import-model', exitCode: 0, envelopeOk: true },
        { step: 'inspect-after-second', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
        { step: 'save', npmScript: 'save', exitCode: 0, envelopeOk: true },
      ],
      inspectSeed: seed,
      inspectAfterFirst: afterFirst,
      inspectAfterSecond: afterFirst,
    };
    const scored = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report,
    });
    expect(scored.technicalPass).toBe(true);

    const duplicated = {
      ...report,
      inspectAfterSecond: { ...afterFirst, assetCount: 2, importedModelCount: 2 },
    };
    const dupFail = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report: duplicated,
    });
    expect(dupFail.technicalPass).toBe(false);
    expect(dupFail.checks.find((entry) => entry.id === 'continuity.assetCount')?.ok).toBe(false);
  });

  it('scores fresh-profile-recovery candidate reports', () => {
    const contract = {
      version: 1 as const,
      id: 'agentic-control-v4' as const,
      family: 'fresh-profile-recovery' as const,
      description: 'fixture',
      seedPackage: '../agentic-control-v2/seed/operator-corridor.fsp',
      artifacts: {
        savedProject: 'project.fsp',
        candidateReport: 'work/candidate-report.json',
      },
      thresholds: { minBytes: 1024 },
      scoring: { checkRepositoryDrift: false },
    };
    const inspect = {
      projectId: 'project_fixture',
      shotIds: ['shot_a', 'shot_b'],
      castCount: 1,
      assetCount: 0,
    };
    const report = {
      runner: 'cheap-agent' as const,
      profiles: {
        primary: '/tmp/run/profile',
        fresh: '/tmp/run/profile-fresh',
      },
      invocations: [
        { step: 'open-seed', npmScript: 'open', exitCode: 0, envelopeOk: true, profile: '/tmp/run/profile' },
        { step: 'inspect-before', npmScript: 'inspect', exitCode: 0, envelopeOk: true, profile: '/tmp/run/profile' },
        { step: 'save', npmScript: 'save', exitCode: 0, envelopeOk: true, profile: '/tmp/run/profile' },
        { step: 'reopen-fresh', npmScript: 'open', exitCode: 0, envelopeOk: true, profile: '/tmp/run/profile-fresh' },
        { step: 'inspect-after', npmScript: 'inspect', exitCode: 0, envelopeOk: true, profile: '/tmp/run/profile-fresh' },
      ],
      inspectBefore: inspect,
      inspectAfter: inspect,
      clayFrame: { status: 'skipped' as const, reason: 'optional' },
    };
    const scored = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report,
    });
    expect(scored.technicalPass).toBe(true);

    const sameProfile = {
      ...report,
      profiles: { primary: '/tmp/run/profile', fresh: '/tmp/run/profile' },
      invocations: report.invocations.map((entry) => (
        entry.step === 'reopen-fresh' ? { ...entry, profile: '/tmp/run/profile' } : entry
      )),
    };
    const profileFail = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report: sameProfile,
    });
    expect(profileFail.technicalPass).toBe(false);
    expect(profileFail.checks.find((entry) => entry.id === 'continuity.profilePaths')?.ok).toBe(false);
  });

  it('accepts brief-style step aliases for frame and reopen', () => {
    const contract = {
      version: 1 as const,
      id: 'agentic-control-v1' as const,
      family: 'lifecycle-control' as const,
      description: 'fixture',
      seedPackage: 'seed/lifecycle-temple.fsp',
      render: { shotSelector: 'first', mode: 'clay' as const, artifact: 'work/artifacts/clay-frame.png' },
      artifacts: {
        savedProject: 'project.fsp',
        candidateReport: 'work/candidate-report.json',
        packageExport: 'work/artifacts/export-package.zip',
      },
      thresholds: { minBytes: 1024 },
      scoring: { requirePackageWhenCapable: true, checkRepositoryDrift: false },
    } satisfies AgenticControlContract;

    const briefStyle = {
      ...baseReport(),
      invocations: [
        { step: 'capabilities', npmScript: 'capabilities', exitCode: 0, envelopeOk: true },
        { step: 'open-seed', npmScript: 'open', exitCode: 0, envelopeOk: true },
        { step: 'inspect-before', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
        { step: 'frame', npmScript: 'frame', exitCode: 0, envelopeOk: true },
        { step: 'save', npmScript: 'save', exitCode: 0, envelopeOk: true },
        { step: 'open-saved', npmScript: 'open', exitCode: 0, envelopeOk: true },
        { step: 'inspect-after', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
        { step: 'package', npmScript: 'package', exitCode: 0, envelopeOk: true },
      ],
    };
    const scored = scoreAgenticControlCandidateReport({
      contract,
      runRoot: '/tmp/run',
      report: briefStyle,
    });
    expect(scored.technicalPass).toBe(true);
    expect(scored.checks.find((check) => check.id === 'invocation.render-clay')?.ok).toBe(true);
    expect(scored.checks.find((check) => check.id === 'invocation.reopen')?.ok).toBe(true);
  });

  it('scores a run without harness evidence using the candidate report', async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-agentic-score-'));
    const workDir = path.join(runRoot, 'work');
    const artifactDir = path.join(workDir, 'artifacts');
    await mkdir(artifactDir, { recursive: true });

    const inspect = {
      projectId: 'project_fixture',
      shotIds: ['shot_a'],
      castCount: 1,
      assetCount: 0,
    };
    const report = {
      runner: 'cheap-agent' as const,
      invocations: [
        { step: 'capabilities', npmScript: 'capabilities', exitCode: 0, envelopeOk: true },
        { step: 'open-seed', npmScript: 'open', exitCode: 0, envelopeOk: true },
        { step: 'inspect-before', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
        { step: 'frame', npmScript: 'frame', exitCode: 0, envelopeOk: true },
        { step: 'save', npmScript: 'save', exitCode: 0, envelopeOk: true },
        { step: 'open-saved', npmScript: 'open', exitCode: 0, envelopeOk: true },
        { step: 'inspect-after', npmScript: 'inspect', exitCode: 0, envelopeOk: true },
        { step: 'package', npmScript: 'package', exitCode: 0, envelopeOk: true },
      ],
      capabilities: { exportPackage: false },
      inspectBefore: inspect,
      inspectAfter: inspect,
      package: { status: 'skipped' as const, reason: 'export.package unavailable in capabilities' },
    };
    await writeFile(path.join(workDir, 'candidate-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    // Minimal valid PNG (>1KB) and FSP for artifact gates.
    const png = Buffer.alloc(1100);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.write('IHDR', 12);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    png.write('IEND', png.length - 4);
    await writeFile(path.join(artifactDir, 'clay-frame.png'), png);

    const projectDoc = {
      id: inspect.projectId,
      shots: [{ id: 'shot_a' }],
      scene: { objects: [{ id: 'obj_1', type: 'human_dummy' }] },
      assets: { assets: {} },
    };
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(projectDoc));
    zip.file('integrity.json', '{}');
    zip.file('padding.bin', Buffer.alloc(1200, 0));
    await writeFile(path.join(runRoot, 'project.fsp'), await zip.generateAsync({ type: 'nodebuffer' }));

    const scored = await scoreAgenticControlRun({
      contractPath,
      runRoot,
    });
    expect(scored.checks.find((check) => check.id === 'evidence.harness')?.ok).toBe(true);
    expect(scored.checks.find((check) => check.id === 'evidence.candidateReport')).toBeUndefined();
    expect(scored.technicalPass).toBe(true);
  });
});
