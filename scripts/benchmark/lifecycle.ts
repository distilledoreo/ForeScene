/**
 * Lifecycle bookkeeping owned by the harness, not the candidate.
 *
 * Live steps call documented Agent CLI commands. Unit tests exercise the
 * record shape without opening a browser.
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

function projectFingerprint(envelope: { projectId?: string; revisionId?: string; result?: unknown }): string {
  const result = envelope.result && typeof envelope.result === 'object'
    ? envelope.result as Record<string, unknown>
    : {};
  const project = result.project && typeof result.project === 'object'
    ? result.project as Record<string, unknown>
    : {};
  return JSON.stringify({
    projectId: envelope.projectId ?? project.projectId ?? project.id,
    revisionId: envelope.revisionId ?? project.revisionId,
  });
}

export async function runLiveLifecycle(input: {
  layout: BenchmarkRunLayout;
  url: string;
  projectPackage?: string;
}): Promise<{ records: LifecycleRecord[]; failure?: BenchmarkFailure }> {
  const root = repoRoot();
  const common = {
    repoRoot: root,
    url: input.url,
    profile: input.layout.profileDir,
  };

  const inspectOnce = () => invokeAgentCli({
    ...common,
    args: ['inspect', '--document'],
  });

  if (input.projectPackage) {
    const opened = await invokeAgentCli({
      ...common,
      args: ['open', '--file', input.projectPackage, '--write'],
    });
    if (opened.code !== 0 || opened.envelope?.ok === false) {
      const failure = failureFromInvocation(opened, 'project.open');
      return {
        records: [
          { id: 'cold-open', status: 'failed', message: failure.message, operation: failure.operation },
          { id: 'incremental', status: 'skipped', message: 'Stopped after cold-open failure.' },
          { id: 'recovery', status: 'skipped', message: 'Stopped after cold-open failure.' },
        ],
        failure,
      };
    }
  }

  const cold = await inspectOnce();
  if (cold.code !== 0 || cold.envelope?.ok === false) {
    const failure = failureFromInvocation(cold, 'project.inspect');
    return {
      records: [
        { id: 'cold-open', status: 'failed', message: failure.message, operation: failure.operation },
        { id: 'incremental', status: 'skipped', message: 'Stopped after cold-open failure.' },
        { id: 'recovery', status: 'skipped', message: 'Stopped after cold-open failure.' },
      ],
      failure,
    };
  }
  const coldFingerprint = projectFingerprint(cold.envelope!);

  const incremental = await inspectOnce();
  if (incremental.code !== 0 || incremental.envelope?.ok === false) {
    const failure = failureFromInvocation(incremental, 'project.inspect');
    return {
      records: [
        { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
        { id: 'incremental', status: 'failed', message: failure.message, operation: failure.operation },
        { id: 'recovery', status: 'skipped', message: 'Stopped after incremental failure.' },
      ],
      failure,
    };
  }
  const incrementalFingerprint = projectFingerprint(incremental.envelope!);
  const hashesUnchanged = coldFingerprint === incrementalFingerprint ? ['project.identity'] : [];

  const recoveryPath = path.join(input.layout.projectDir, 'lifecycle-recovery.fsp');
  const saved = await invokeAgentCli({
    ...common,
    args: ['save', '--output', recoveryPath, '--write'],
  });
  if (saved.code !== 0 || saved.envelope?.ok === false) {
    const failure = failureFromInvocation(saved, 'project.save');
    return {
      records: [
        { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
        {
          id: 'incremental',
          status: hashesUnchanged.length > 0 ? 'passed' : 'failed',
          message: hashesUnchanged.length > 0
            ? 'Second inspect kept the same project identity.'
            : 'Second inspect reported a different project identity.',
          hashesUnchanged,
          operation: 'project.inspect',
        },
        { id: 'recovery', status: 'failed', message: failure.message, operation: failure.operation },
      ],
      failure,
    };
  }

  const reopened = await invokeAgentCli({
    ...common,
    args: ['open', '--file', recoveryPath, '--write'],
  });
  if (reopened.code !== 0 || reopened.envelope?.ok === false) {
    const failure = failureFromInvocation(reopened, 'project.open');
    return {
      records: [
        { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
        {
          id: 'incremental',
          status: 'passed',
          message: 'Second inspect kept the same project identity.',
          hashesUnchanged,
          operation: 'project.inspect',
        },
        { id: 'recovery', status: 'failed', message: failure.message, operation: failure.operation },
      ],
      failure,
    };
  }

  const recovered = await inspectOnce();
  if (recovered.code !== 0 || recovered.envelope?.ok === false) {
    const failure = failureFromInvocation(recovered, 'project.inspect');
    return {
      records: [
        { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
        {
          id: 'incremental',
          status: 'passed',
          message: 'Second inspect kept the same project identity.',
          hashesUnchanged,
          operation: 'project.inspect',
        },
        { id: 'recovery', status: 'failed', message: failure.message, operation: failure.operation },
      ],
      failure,
    };
  }

  return {
    records: [
      { id: 'cold-open', status: 'passed', message: 'Inspect succeeded on a fresh profile.', operation: 'project.inspect' },
      {
        id: 'incremental',
        status: hashesUnchanged.length > 0 ? 'passed' : 'failed',
        message: hashesUnchanged.length > 0
          ? 'Second inspect kept the same project identity.'
          : 'Second inspect reported a different project identity.',
        hashesUnchanged,
        operation: 'project.inspect',
      },
      {
        id: 'recovery',
        status: 'passed',
        message: 'Save, reopen, and inspect succeeded.',
        operation: 'project.save',
      },
    ],
    failure: hashesUnchanged.length > 0
      ? undefined
      : {
        class: 'INFRASTRUCTURE_FAILURE',
        operation: 'project.inspect',
        message: 'Incremental inspect changed project identity without a candidate write.',
      },
  };
}
