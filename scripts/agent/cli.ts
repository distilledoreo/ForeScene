#!/usr/bin/env tsx
/**
 * ForeScene Agent CLI — Playwright host for window.foreScene.
 *
 * Usage:
 *   npm run agent:inspect
 *   npm run agent:preview -- --plan plans/example.json
 *   npm run agent:apply -- --plan plans/example.json
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openAgentBrowser } from './browser';
import { inspectViaBrowser } from './inspect';

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv: string[]) {
  const args = {
    command: argv[0] ?? 'inspect',
    plan: undefined as string | undefined,
    url: undefined as string | undefined,
    headless: false,
    writeAccess: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--plan') {
      args.plan = argv[++index];
    } else if (token === '--url') {
      args.url = argv[++index];
    } else if (token === '--headless') {
      args.headless = true;
    } else if (token === '--write') {
      args.writeAccess = true;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown flag: ${token}`);
    }
  }

  return args;
}

async function previewOrApply(
  command: 'preview' | 'apply',
  planPath: string,
  options: { url?: string; headless: boolean; writeAccess: boolean },
) {
  const raw = await readFile(path.resolve(planPath), 'utf8');
  const plan = JSON.parse(raw) as unknown;
  const session = await openAgentBrowser({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess || command === 'apply' || command === 'preview',
  });
  try {
    const result = await session.page.evaluate(async ({ commandName, planJson }) => {
      const api = window.foreScene;
      if (!api) throw new Error('window.foreScene is not available');
      if (commandName === 'preview') return api.previewPlan(planJson);
      return api.applyPlan(planJson);
    }, { commandName: command, planJson: plan });
    printJson(result);
    if (!result || typeof result !== 'object' || !('ok' in result) || !(result as { ok: boolean }).ok) {
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  printErr(`[agent] command=${args.command}`);

  if (args.command === 'inspect') {
    const session = await openAgentBrowser({
      url: args.url,
      headless: args.headless || process.env.CI === 'true' || !process.stdout.isTTY,
      writeAccess: args.writeAccess,
    });
    try {
      printErr(`[agent] connected ${session.url}`);
      const payload = await inspectViaBrowser(session.page);
      printJson(payload);
    } finally {
      await session.close();
    }
    return;
  }

  if (args.command === 'preview' || args.command === 'apply') {
    if (!args.plan) {
      throw new Error(`--plan is required for ${args.command}`);
    }
    await previewOrApply(args.command, args.plan, args);
    return;
  }

  if (args.command === 'screenshot' || args.command === 'verify') {
    printJson({
      ok: false,
      diagnostics: [{
        code: 'not_implemented',
        severity: 'error',
        message: `${args.command} lands in a later Agent API milestone.`,
      }],
    });
    process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  printErr(`[agent] ${message}`);
  printJson({
    ok: false,
    error: message,
  });
  process.exitCode = 1;
});
