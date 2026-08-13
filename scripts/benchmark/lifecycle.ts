/**
 * Lifecycle bookkeeping owned by the harness, not the candidate.
 *
 * Incremental must mutate, save, and re-inspect. Recovery must save, reopen
 * on a fresh profile, and verify project identity.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { failureFromInvocation, invokeAgentCli } from './agentCli';
import type { BenchmarkFailure } from './types';
import type { BenchmarkRunLayout } from './layout';
import { repoRoot } from './layout';

export interface LifecycleRecord {
  id: 'cold-open' | 'incremental' | 'recovery';
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  hashesUnchanged?: string[];
  operation?: string;
}

export async function writeLifecycleRecords(
  layout: BenchmarkRunLayout,
  records: LifecycleRecord[],
): Promise<void> {
  for (const record of records) {
    await writeFile(
      path.join(layout.lifecycleDir, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
  }
}

export function skippedLiveLifecycle(reason: string): LifecycleRecord[] {
  return [
    { id: 'cold-open', status: 'skipped', message: reason },
    { id: 'incremental', status: 'skipped', message: reason },
    { id: 'recovery', status: 'skipped', message: reason },
  ];
}

export function incrementalMutationPlan(): { version: 1; commands: Array<Record<string, unknown>> } {
  return {
    version: 1,
    commands: [
      {
        op: 'project.updateInfo',
        description: `benchmark-lifecycle-incremental ${new Date().toISOString()}`,
      },
    ],
  };
}

function projectIdOf(envelope: { projectId?: string; result?: unknown }): string | undefined {
  const result = envelope.result && typeof envelope.result === 'object'
    ? envelope.result as Record<string, unknown>
    : {};
  const project = result.project && typeof result.project === 'object'
    ? result.project as Record<string, unknown>
    : {};
  const nested = result.result && typeof result.result === 'object'
    ? result.result as Record<string, unknown>
    : {};
  const nestedProject = nested.project && typeof nested.project === 'object'
    ? nested.project as Record<string, unknown>
    : {};
  return envelope.projectId
    ?? (typeof project.id === 'string' ? project.id : undefined)
    ?? (typeof project.projectId === 'string' ? project.projectId : undefined)
    ?? (typeof nestedProject.id === 'string' ? nestedProject.id : undefined);
}

function revisionIdOf(envelope: { revisionId?: string; result?: unknown }): string | undefined {
  const result = envelope.result && typeof envelope.result === 'object'
    ? envelope.result as Record<string, unknown>
    : {};
  const status = result.status && typeof result.status === 'object'
    ? result.status as Record<string, unknown>
    : {};
  return envelope.revisionId
    ?? (typeof status.revisionId === 'string' ? status.revisionId : undefined)
    ?? (typeof result.revisionId === 'string' ? result.revisionId : undefined);
}

function failed(
  records: LifecycleRecord[],
  failure: BenchmarkFailure,
): { records: LifecycleRecord[]; failure: BenchmarkFailure } {
  return { records, failure };
}

export async function runLiveLifecycle(input: {
  layout: BenchmarkRunLayout;
  url: string;
  projectPackage?: string;
}): Promise<{ records: LifecycleRecord[]; failure?: BenchmarkFailure }> {
  const root = repoRoot();
  const workCwd = input.layout.workDir;
  const common = {
    repoRoot: root,
    url: input.url,
    profile: input.layout.profileDir,
    cwd: workCwd,
  };

  const inspectOn = (profile: string) => invokeAgentCli({
    ...common,
    profile,
    args: ['inspect', '--document'],
  });

  if (input.projectPackage) {
    const opened = await invokeAgentCli({
      ...common,
      args: ['open', '--file', input.projectPackage, '--write'],
    });
    if (opened.code !== 0 || opened.envelope?.ok === false) {
      const failure = failureFromInvocation(opened, 'project.open');
      return failed([
        { id: 'cold-open', status: 'failed', message: failure.message, operation: failure.operation },
        { id: 'incremental', status: 'skipped', message: 'Stopped after cold-open failure.' },
        { id: 'recovery', status: 'skipped', message: 'Stopped after cold-open failure.' },
      ], failure);
    }
  }

  const cold = await inspectOn(input.layout.profileDir);
  if (cold.code !== 0 || cold.envelope?.ok === false) {
    const failure = failureFromInvocation(cold, 'project.inspect');
    return failed([
      { id: 'cold-open', status: 'failed', message: failure.message, operation: failure.operation },
      { id: 'incremental', status: 'skipped', message: 'Stopped after cold-open failure.' },
      { id: 'recovery', status: 'skipped', message: 'Stopped after cold-open failure.' },
    ], failure);
  }
  const projectId = projectIdOf(cold.envelope!);
  const coldRevision = revisionIdOf(cold.envelope!);

  const planPath = path.join(input.layout.workDir, 'lifecycle-incremental.json');
  await writeFile(planPath, `${JSON.stringify(incrementalMutationPlan(), null, 2)}\n`);
  const applied = await invokeAgentCli({
    ...common,
    args: ['apply', '--plan', planPath, '--write'],
  });
  if (applied.code !== 0 || applied.envelope?.ok === false) {
    const failure = failureFromInvocation(applied, 'project.applyPlan');
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'failed', message: failure.message, operation: failure.operation },
      { id: 'recovery', status: 'skipped', message: 'Stopped after incremental failure.' },
    ], failure);
  }

  const incrementalPath = path.join(input.layout.projectDir, 'lifecycle-incremental.fsp');
  const savedIncremental = await invokeAgentCli({
    ...common,
    args: ['save', '--output', incrementalPath, '--write'],
  });
  if (savedIncremental.code !== 0 || savedIncremental.envelope?.ok === false) {
    const failure = failureFromInvocation(savedIncremental, 'project.save');
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'failed', message: failure.message, operation: failure.operation },
      { id: 'recovery', status: 'skipped', message: 'Stopped after incremental failure.' },
    ], failure);
  }

  const afterMutation = await inspectOn(input.layout.profileDir);
  if (afterMutation.code !== 0 || afterMutation.envelope?.ok === false) {
    const failure = failureFromInvocation(afterMutation, 'project.inspect');
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'failed', message: failure.message, operation: failure.operation },
      { id: 'recovery', status: 'skipped', message: 'Stopped after incremental failure.' },
    ], failure);
  }
  const mutatedProjectId = projectIdOf(afterMutation.envelope!);
  const mutatedRevision = revisionIdOf(afterMutation.envelope!);
  const incrementalOk = Boolean(projectId && mutatedProjectId === projectId)
    && Boolean(mutatedRevision && mutatedRevision !== coldRevision);
  if (!incrementalOk) {
    const failure: BenchmarkFailure = {
      class: 'HARNESS_FAILURE',
      operation: 'project.applyPlan',
      message: 'Incremental mutate/save/inspect did not preserve project id while changing revision.',
    };
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'failed', message: failure.message, operation: failure.operation },
      { id: 'recovery', status: 'skipped', message: 'Stopped after incremental failure.' },
    ], failure);
  }

  const recoveryPath = path.join(input.layout.projectDir, 'lifecycle-recovery.fsp');
  const saved = await invokeAgentCli({
    ...common,
    args: ['save', '--output', recoveryPath, '--write'],
  });
  if (saved.code !== 0 || saved.envelope?.ok === false) {
    const failure = failureFromInvocation(saved, 'project.save');
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'passed', message: 'Mutate, save, and inspect changed revision while preserving project id.', hashesUnchanged: ['project.id'], operation: 'project.applyPlan' },
      { id: 'recovery', status: 'failed', message: failure.message, operation: failure.operation },
    ], failure);
  }

  const reopened = await invokeAgentCli({
    ...common,
    profile: input.layout.recoveryProfileDir,
    args: ['open', '--file', recoveryPath, '--write'],
  });
  if (reopened.code !== 0 || reopened.envelope?.ok === false) {
    const failure = failureFromInvocation(reopened, 'project.open');
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'passed', message: 'Mutate, save, and inspect changed revision while preserving project id.', hashesUnchanged: ['project.id'], operation: 'project.applyPlan' },
      { id: 'recovery', status: 'failed', message: failure.message, operation: failure.operation },
    ], failure);
  }

  const recovered = await inspectOn(input.layout.recoveryProfileDir);
  if (recovered.code !== 0 || recovered.envelope?.ok === false) {
    const failure = failureFromInvocation(recovered, 'project.inspect');
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'passed', message: 'Mutate, save, and inspect changed revision while preserving project id.', hashesUnchanged: ['project.id'], operation: 'project.applyPlan' },
      { id: 'recovery', status: 'failed', message: failure.message, operation: failure.operation },
    ], failure);
  }
  const recoveredProjectId = projectIdOf(recovered.envelope!);
  if (!projectId || recoveredProjectId !== projectId) {
    const failure: BenchmarkFailure = {
      class: 'INFRASTRUCTURE_FAILURE',
      operation: 'project.open',
      message: `Recovery reopen lost project identity (${projectId} → ${recoveredProjectId ?? 'missing'}).`,
    };
    return failed([
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      { id: 'incremental', status: 'passed', message: 'Mutate, save, and inspect changed revision while preserving project id.', hashesUnchanged: ['project.id'], operation: 'project.applyPlan' },
      { id: 'recovery', status: 'failed', message: failure.message, operation: failure.operation },
    ], failure);
  }

  return {
    records: [
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      {
        id: 'incremental',
        status: 'passed',
        message: 'Mutate, save, and inspect changed revision while preserving project id.',
        hashesUnchanged: ['project.id'],
        operation: 'project.applyPlan',
      },
      {
        id: 'recovery',
        status: 'passed',
        message: 'Save, reopen on a fresh profile, and inspect preserved project identity.',
        hashesUnchanged: ['project.id'],
        operation: 'project.save',
      },
    ],
  };
}
