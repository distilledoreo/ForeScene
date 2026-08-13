import path from 'node:path';
import { loadBenchmarkSpec } from '../benchmark/spec';
import { repoRoot } from '../benchmark/layout';
import { gradeVisualDiagnostics } from '../benchmark/visualGrade';
import { invokeAgentCli } from '../benchmark/agentCli';
import { SOAK_GATE_NAMES, type SoakGateResult } from './types';

function baselinePayload() {
  return {
    result: {
      visualPreflight: [
        {
          shotId: 's010',
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
          subjects: [{ objectId: 'obj_lead_1', name: 'Lead' }],
          presentSubjectIds: ['obj_lead_1'],
          missingSubjectIds: [],
          checks: [
            { id: 'camera_direction', status: 'passed' },
            { id: 'subject_visibility', status: 'passed' },
            { id: 'framing_coverage', status: 'passed' },
            { id: 'motion_continuity', status: 'passed' },
          ],
          samples: [{ timeSeconds: 0 }, { timeSeconds: 1 }, { timeSeconds: 2 }],
        },
      ],
    },
  };
}

export async function runGateF(input: {
  url?: string;
  profileDir?: string;
}): Promise<SoakGateResult> {
  const started = Date.now();
  const spec = await loadBenchmarkSpec(path.join(repoRoot(), 'benchmarks/three-shot.json'));
  if (JSON.stringify(spec).match(/cameraMustBe|cameraPosition/)) {
    return {
      id: 'F',
      name: SOAK_GATE_NAMES.F,
      status: 'failed',
      requiredLive: false,
      message: 'Visual baseline spec encodes camera coordinates.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }
  const grade = gradeVisualDiagnostics(spec, baselinePayload());
  if (!grade.ok) {
    return {
      id: 'F',
      name: SOAK_GATE_NAMES.F,
      status: 'failed',
      requiredLive: false,
      message: grade.message,
      durationMs: Date.now() - started,
      retries: 0,
      details: grade.checks,
    };
  }

  const implicitFail = gradeVisualDiagnostics(spec, {
    result: { visualPreflight: [{ shotId: 's010', missingSubjectIds: [], checks: [] }] },
  });
  if (implicitFail.ok) {
    return {
      id: 'F',
      name: SOAK_GATE_NAMES.F,
      status: 'failed',
      requiredLive: false,
      message: 'Visual grader must fail closed when required checks are absent.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }

  if (!input.url || !input.profileDir) {
    return {
      id: 'F',
      name: SOAK_GATE_NAMES.F,
      status: 'skipped',
      requiredLive: true,
      message: 'Fail-closed fixture passed. Live visual-preflight is required for stabilization and was skipped.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }

  const live = await invokeAgentCli({
    repoRoot: repoRoot(),
    args: ['visual-preflight'],
    url: input.url,
    profile: input.profileDir,
  });
  if (!live.envelope) {
    return {
      id: 'F',
      name: SOAK_GATE_NAMES.F,
      status: 'failed',
      requiredLive: true,
      message: live.stderr.slice(-400) || 'visual-preflight returned no envelope.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }

  return {
    id: 'F',
    name: SOAK_GATE_NAMES.F,
    status: 'passed',
    requiredLive: true,
    message: 'Fail-closed visual rules passed and live visual-preflight returned an envelope.',
    durationMs: Date.now() - started,
    retries: 0,
    details: { liveOperation: live.envelope.operation, liveOk: live.envelope.ok },
  };
}
