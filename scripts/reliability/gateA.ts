import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_CLI_CAPABILITY_RECORDS,
  buildAgentCliCapabilityMap,
  renderCapabilityMatrixMarkdown,
} from '../agent/cliCapabilities';
import { AGENT_CLI_COMMANDS } from '../agent/cliCommands';
import { loadBenchmarkSpec } from '../benchmark/spec';
import { repoRoot } from '../benchmark/layout';
import { SOAK_GATE_NAMES, type SoakGateResult } from './types';

export async function runGateA(): Promise<SoakGateResult> {
  const started = Date.now();
  const root = repoRoot();
  const checks: string[] = [];

  const matrixPath = path.join(root, 'docs/agent-capability-matrix.md');
  const onDisk = await readFile(matrixPath, 'utf8');
  if (onDisk !== renderCapabilityMatrixMarkdown()) {
    return failA(started, 'docs/agent-capability-matrix.md is out of date with the CLI catalog.');
  }
  checks.push('capability matrix matches generator');

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  for (const command of AGENT_CLI_COMMANDS) {
    const script = `agent:${command}`;
    if (!packageJson.scripts?.[script]) {
      return failA(started, `Missing package.json script ${script}.`);
    }
  }
  checks.push(`${AGENT_CLI_COMMANDS.length} agent:* scripts present`);

  const capabilities = buildAgentCliCapabilityMap();
  const spec = await loadBenchmarkSpec(path.join(root, 'benchmarks/three-shot.json'));
  const missing = spec.requiredCliCapabilities.filter((id) => capabilities[id] !== true);
  if (missing.length > 0) {
    return failA(started, `three-shot required capabilities are not CLI-true: ${missing.join(', ')}`);
  }
  checks.push('three-shot required capabilities are CLI-true');

  const skill = await readFile(path.join(root, 'skills/forescene-previs/SKILL.md'), 'utf8');
  for (const phrase of ['agent:capabilities', 'agent:frame', 'agent:open', 'agent:save', 'Do not kill Chromium']) {
    if (!skill.includes(phrase)) {
      return failA(started, `Skill is missing contract phrase: ${phrase}`);
    }
  }
  checks.push('skill documents CLI-first operation');

  const undocumented = AGENT_CLI_CAPABILITY_RECORDS.filter((record) => record.cli && !record.skillDocumented);
  if (undocumented.length > 0) {
    return failA(started, `CLI capabilities not marked skillDocumented: ${undocumented.map((record) => record.id).join(', ')}`);
  }

  return {
    id: 'A',
    name: SOAK_GATE_NAMES.A,
    status: 'passed',
    requiredLive: false,
    message: checks.join('; '),
    durationMs: Date.now() - started,
    retries: 0,
    details: { capabilityCount: AGENT_CLI_CAPABILITY_RECORDS.length },
  };
}

function failA(started: number, message: string): SoakGateResult {
  return {
    id: 'A',
    name: SOAK_GATE_NAMES.A,
    status: 'failed',
    requiredLive: false,
    message,
    durationMs: Date.now() - started,
    retries: 0,
  };
}
