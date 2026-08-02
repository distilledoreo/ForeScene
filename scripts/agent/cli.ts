#!/usr/bin/env tsx
/**
 * ForeScene Agent CLI — Playwright host for window.foreScene.
 *
 * Usage:
 *   npm run agent:inspect
 *   npm run agent:preview -- --plan plans/example.json
 *   npm run agent:apply -- --plan plans/example.json --write
 *   npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
 *   npm run agent:run -- --plan plans/example.json --screenshot artifacts/out.png --write
 *   npm run agent:package -- --write --output artifacts/package.zip
 *   npm run agent:previs -- --manifest examples/previs/minimal-dialogue.json --write --reset-project --output artifacts/previs
 *   npm run agent:render-stills -- --output artifacts/previs
 *   npm run agent:contact-sheet -- --input artifacts/previs/shots --output artifacts/previs/contact-sheet.png
 *
 * Write commands require explicit `--write` (session) or `--persist-write` (profile).
 * Project reset additionally requires `--reset-project`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openAgentBrowser, waitForAgentIdle, type AgentBrowserSession } from './browser';
import { inspectViaBrowser } from './inspect';
import { captureSceneScreenshot, openWorkspace } from './screenshot';
import { runContactSheetCli, runPrevisCli, runRenderStillsCli } from './previs';

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
    manifest: undefined as string | undefined,
    url: undefined as string | undefined,
    headless: false,
    writeAccess: false,
    persistWrite: false,
    resetProject: false,
    updateManifest: false,
    initializeOnly: false,
    skipPackage: false,
    workspace: undefined as string | undefined,
    output: undefined as string | undefined,
    screenshot: undefined as string | undefined,
    input: undefined as string | undefined,
    file: undefined as string | undefined,
    mapping: undefined as string | undefined,
    rigMode: 'preserve' as 'preserve' | 'autorig' | 'auto',
    name: undefined as string | undefined,
    consentToken: undefined as string | undefined,
    profile: undefined as string | undefined,
    shotIds: [] as string[],
    timeSeconds: undefined as number | undefined,
    resolution: undefined as string | undefined,
    appearance: undefined as string | undefined,
    content: undefined as string | undefined,
    noAttach: false,
    noDownload: false,
    allowHeavyCharacterImports: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--plan') {
      args.plan = argv[++index];
    } else if (token === '--manifest') {
      args.manifest = argv[++index];
    } else if (token === '--url') {
      args.url = argv[++index];
    } else if (token === '--headless') {
      args.headless = true;
    } else if (token === '--write') {
      args.writeAccess = true;
    } else if (token === '--persist-write') {
      args.persistWrite = true;
      args.writeAccess = true;
    } else if (token === '--reset-project') {
      args.resetProject = true;
    } else if (token === '--update-manifest') {
      args.updateManifest = true;
    } else if (token === '--allow-heavy-character-imports') {
      args.allowHeavyCharacterImports = true;
    } else if (token === '--initialize-only') {
      args.initializeOnly = true;
    } else if (token === '--skip-package') {
      args.skipPackage = true;
    } else if (token === '--workspace') {
      args.workspace = argv[++index];
    } else if (token === '--output') {
      args.output = argv[++index];
    } else if (token === '--screenshot') {
      args.screenshot = argv[++index];
    } else if (token === '--input') {
      args.input = argv[++index];
    } else if (token === '--file') {
      args.file = argv[++index];
    } else if (token === '--mapping') {
      args.mapping = argv[++index];
    } else if (token === '--rig-mode') {
      const mode = argv[++index];
      if (mode !== 'preserve' && mode !== 'autorig' && mode !== 'auto') {
        throw new Error('--rig-mode must be preserve, autorig, or auto');
      }
      args.rigMode = mode;
    } else if (token === '--name') {
      args.name = argv[++index];
    } else if (token === '--consent-token') {
      args.consentToken = argv[++index];
    } else if (token === '--profile') {
      args.profile = argv[++index];
    } else if (token === '--shot') {
      const shotId = argv[++index];
      if (shotId) args.shotIds.push(shotId);
    } else if (token === '--time') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value)) throw new Error('--time must be a finite number');
      args.timeSeconds = value;
    } else if (token === '--resolution') {
      args.resolution = argv[++index];
    } else if (token === '--appearance') {
      args.appearance = argv[++index];
    } else if (token === '--content') {
      args.content = argv[++index];
    } else if (token === '--no-attach') {
      args.noAttach = true;
    } else if (token === '--no-download') {
      args.noDownload = true;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown flag: ${token}`);
    }
  }

  return args;
}

async function runCharacterAnalysis(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  file: string;
  output?: string;
}) {
  const target = path.resolve(options.file);
  await withSession(options, async (session) => {
    await session.page.locator('[data-agent-character-import-input]').setInputFiles(target);
    const result = await session.page.evaluate(async (input) => {
      const fileInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
      const file = fileInput?.files?.[0];
      if (!file) throw new Error('Character file was not staged in the browser.');
      return window.foreScene!.analyzeCharacterImport({ file, mode: 'auto' });
    }, undefined);
    if (options.output) {
      const output = path.resolve(options.output);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    printJson({ ...result, ...(options.output ? { output: path.resolve(options.output) } : {}) });
  });
}

async function runCharacterImport(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  file: string;
  mapping?: string;
  rigMode: 'preserve' | 'autorig' | 'auto';
  name?: string;
  consentToken?: string;
}) {
  requireExplicitWrite('agent:import-character', options.writeAccess);
  const target = path.resolve(options.file);
  let mappingOverrides: Record<string, string> | undefined;
  if (options.mapping) {
    const mappingPath = options.mapping;
    const parsed = JSON.parse(await readFile(path.resolve(mappingPath), 'utf8')) as unknown;
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const candidate = record.mappingOverrides && typeof record.mappingOverrides === 'object'
      ? record.mappingOverrides as Record<string, unknown>
      : record;
    mappingOverrides = Object.fromEntries(
      Object.entries(candidate).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  await withSession(options, async (session) => {
    await session.page.locator('[data-agent-character-import-input]').setInputFiles(target);
    const result = await session.page.evaluate(async (input) => {
      const fileInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
      const file = fileInput?.files?.[0];
      if (!file) throw new Error('Character file was not staged in the browser.');
      const analysis = await window.foreScene!.analyzeCharacterImport({ file, mode: input.rigMode === 'auto' ? 'auto' : input.rigMode === 'preserve' ? 'preserveExistingRig' : 'autorig' });
      const mode = input.rigMode === 'autorig'
        ? 'autorig'
        : input.rigMode === 'preserve'
          ? 'preserveExistingRig'
          : analysis.hasSkeleton
            && analysis.hasSkinning
            && analysis.requiredMissing.length === 0
            && (analysis.mappingConfidence ?? 0) >= 0.7
            ? 'preserveExistingRig'
            : 'autorig';
      return window.foreScene!.importCharacter({
        analysisId: analysis.analysisId,
        mode,
        mappingOverrides: input.mappingOverrides,
        name: input.characterName,
        consentToken: input.consentToken,
      });
    }, {
      rigMode: options.rigMode,
      mappingOverrides,
      characterName: options.name,
      consentToken: options.consentToken,
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  });
}

async function runFrame(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  shotId: string;
  timeSeconds?: number;
  output: string;
}) {
  await withSession(options, async (session) => {
    const result = await session.page.evaluate(async (input) => (
      window.foreScene!.renderShotFrame({ shotId: input.shotId, timeSeconds: input.timeSeconds, pass: 'clay' })
    ), { shotId: options.shotId, timeSeconds: options.timeSeconds });
    if (!result.ok || !result.pngDataUrl) {
      printJson(result);
      process.exitCode = 1;
      return;
    }
    const comma = result.pngDataUrl.indexOf(',');
    if (comma < 0) throw new Error('Agent frame response did not contain a data URL.');
    const target = path.resolve(options.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(result.pngDataUrl.slice(comma + 1), 'base64'));
    printJson({ ...result, pngDataUrl: undefined, output: target });
  });
}

async function runVideo(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  shotId: string;
  output?: string;
  resolution?: string;
  appearance?: string;
  content?: string;
  attachToShot: boolean;
  download: boolean;
}) {
  await withSession(options, async (session) => {
    const contentMode = options.content === 'full' ? 'full_scene' : options.content;
    const downloadPromise = options.download && options.output
      ? session.page.waitForEvent('download', { timeout: 600_000 })
      : null;
    const result = await session.page.evaluate(async (input) => (
      window.foreScene!.renderShotVideo({
        shotId: input.shotId,
        resolutionPreset: input.resolution as '720p' | '1080p' | '4k' | undefined,
        appearance: input.appearance as 'clay' | 'projected' | 'depth' | undefined,
        contentMode: input.content as 'full_scene' | 'clean_plate' | 'characters_only' | undefined,
        attachToShot: input.attachToShot,
        download: input.download,
      })
    ), { ...options, content: contentMode });
    let savedPath: string | undefined;
    if (downloadPromise && result.ok) {
      const download = await downloadPromise;
      savedPath = path.resolve(options.output!);
      await mkdir(path.dirname(savedPath), { recursive: true });
      await download.saveAs(savedPath);
    }
    printJson({ ...result, savedPath });
    if (!result.ok) process.exitCode = 1;
  });
}

function requireExplicitWrite(command: string, writeAccess: boolean): void {
  if (!writeAccess) {
    throw new Error(
      `${command} requires --write (session) or --persist-write (trusted profile).`,
    );
  }
}

async function withSession<T>(
  options: {
    url?: string;
    headless: boolean;
    writeAccess: boolean;
    persistWrite: boolean;
  },
  run: (session: AgentBrowserSession) => Promise<T>,
): Promise<T> {
  const session = await openAgentBrowser({
    url: options.url,
    headless: options.headless || process.env.CI === 'true' || !process.stdout.isTTY,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
  });
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

async function previewOrApply(
  command: 'preview' | 'apply',
  planPath: string,
  options: {
    url?: string;
    headless: boolean;
    writeAccess: boolean;
    persistWrite: boolean;
  },
) {
  const raw = await readFile(path.resolve(planPath), 'utf8');
  const plan = JSON.parse(raw) as unknown;
  await withSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
  }, async (session) => {
    if (command === 'apply') {
      await waitForAgentIdle(session.page);
    }
    const result = await session.page.evaluate(async ({ commandName, planJson }) => {
      const api = window.foreScene;
      if (!api) throw new Error('window.foreScene is not available');
      if (commandName === 'preview') return api.previewPlan(planJson);
      await api.waitForIdle({ timeoutMs: 60_000 });
      return api.applyPlan(planJson);
    }, { commandName: command, planJson: plan });
    printJson(result);
    if (!result || typeof result !== 'object' || !('ok' in result) || !(result as { ok: boolean }).ok) {
      process.exitCode = 1;
    }
  });
}

async function runScreenshot(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  workspace?: string;
  output: string;
}) {
  await withSession(options, async (session) => {
    if (options.workspace) {
      await openWorkspace(session.page, options.workspace);
      await waitForAgentIdle(session.page);
    }
    const screenshot = await captureSceneScreenshot(session.page, options.output);
    printJson({
      ok: true,
      screenshot,
      workspace: options.workspace,
      status: await session.page.evaluate(() => window.foreScene!.getStatus()),
    });
  });
}

async function runVerify(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  workspace?: string;
  output?: string;
}) {
  await withSession(options, async (session) => {
    if (options.workspace) {
      await openWorkspace(session.page, options.workspace);
      await waitForAgentIdle(session.page);
    }
    const inspection = await inspectViaBrowser(session.page);
    let screenshot: string | undefined;
    if (options.output) {
      screenshot = await captureSceneScreenshot(session.page, options.output);
    }
    printJson({
      ok: true,
      project: inspection.project,
      objectCount: (inspection.objects as unknown[]).length,
      shotCount: (inspection.shots as unknown[]).length,
      screenshot,
      status: inspection.status,
    });
  });
}

async function runPipeline(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  plan: string;
  screenshot?: string;
  workspace?: string;
}) {
  const raw = await readFile(path.resolve(options.plan), 'utf8');
  const plan = JSON.parse(raw) as unknown;

  await withSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
  }, async (session) => {
    const inspection = await inspectViaBrowser(session.page);
    const preview = await session.page.evaluate(async (planJson) => (
      window.foreScene!.previewPlan(planJson)
    ), plan);
    if (!preview.ok) {
      printJson({ ok: false, stage: 'preview', preview });
      process.exitCode = 1;
      return;
    }

    await waitForAgentIdle(session.page);
    const applied = await session.page.evaluate(async (planJson) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      return window.foreScene!.applyPlan(planJson);
    }, plan);
    if (!applied.ok) {
      printJson({ ok: false, stage: 'apply', applied });
      process.exitCode = 1;
      return;
    }

    await waitForAgentIdle(session.page);

    if (options.workspace) {
      await openWorkspace(session.page, options.workspace);
    }

    let screenshot: string | undefined;
    if (options.screenshot) {
      screenshot = await captureSceneScreenshot(session.page, options.screenshot);
    }

    printJson({
      ok: true,
      planId: applied.planId,
      verifiedRevisionId: applied.verifiedRevisionId,
      affectedObjects: applied.summary?.affectedObjectIds.length ?? 0,
      affectedShots: applied.summary?.affectedShotIds.length ?? 0,
      screenshot,
      inspectedProjectId: (inspection.project as { id?: string }).id,
      previewSummary: preview.summary,
    });
  });
}

async function runPackage(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  output?: string;
  shotIds: string[];
}) {
  await withSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
  }, async (session) => {
    await waitForAgentIdle(session.page);
    printErr('[agent] starting package export…');

    const downloadPromise = options.output
      ? session.page.waitForEvent('download', { timeout: 300_000 })
      : null;

    const result = await session.page.evaluate(async (input) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      return window.foreScene!.exportPackage({
        shotIds: input.shotIds.length > 0 ? input.shotIds : undefined,
        download: true,
      });
    }, { shotIds: options.shotIds });

    let savedPath: string | undefined;
    if (downloadPromise && result.ok) {
      const download = await downloadPromise;
      const target = path.resolve(options.output!);
      await mkdir(path.dirname(target), { recursive: true });
      await download.saveAs(target);
      savedPath = target;
      printErr(`[agent] saved package ${target}`);
    }

    printJson({
      ...result,
      savedPath,
    });
    if (!result.ok) process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  printErr(`[agent] command=${args.command}`);

  if (args.command === 'analyze-character') {
    if (!args.file) throw new Error('analyze-character requires --file <path>.');
    await runCharacterAnalysis({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      file: args.file,
      output: args.output,
    });
    return;
  }

  if (args.command === 'import-character') {
    if (!args.file) throw new Error('import-character requires --file <path>.');
    await runCharacterImport({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      file: args.file,
      mapping: args.mapping,
      rigMode: args.rigMode,
      name: args.name,
    });
    return;
  }

  if (args.command === 'inspect') {
    await withSession({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
    }, async (session) => {
      printErr(`[agent] connected ${session.url}`);
      printJson(await inspectViaBrowser(session.page));
    });
    return;
  }

  if (args.command === 'preview' || args.command === 'apply') {
    if (!args.plan) throw new Error(`--plan is required for ${args.command}`);
    if (args.command === 'apply') {
      requireExplicitWrite('apply', args.writeAccess);
    }
    await previewOrApply(args.command, args.plan, {
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
    });
    return;
  }

  if (args.command === 'screenshot') {
    if (!args.output) throw new Error('--output is required for screenshot');
    await runScreenshot({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      workspace: args.workspace,
      output: args.output,
    });
    return;
  }

  if (args.command === 'frame') {
    const shotId = args.shotIds[0];
    if (!shotId) throw new Error('--shot is required for frame');
    if (!args.output) throw new Error('--output is required for frame');
    await runFrame({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      shotId,
      timeSeconds: args.timeSeconds,
      output: args.output,
    });
    return;
  }

  if (args.command === 'video') {
    const shotId = args.shotIds[0];
    if (!shotId) throw new Error('--shot is required for video');
    requireExplicitWrite('video', args.writeAccess);
    await runVideo({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      shotId,
      output: args.output,
      resolution: args.resolution,
      appearance: args.appearance,
      content: args.content,
      attachToShot: !args.noAttach,
      download: !args.noDownload,
    });
    return;
  }

  if (args.command === 'verify') {
    await runVerify({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      workspace: args.workspace,
      output: args.output ?? args.screenshot,
    });
    return;
  }

  if (args.command === 'run') {
    if (!args.plan) throw new Error('--plan is required for run');
    requireExplicitWrite('run', args.writeAccess);
    await runPipeline({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      plan: args.plan,
      screenshot: args.screenshot ?? args.output,
      workspace: args.workspace ?? 'shots',
    });
    return;
  }

  if (args.command === 'package') {
    requireExplicitWrite('package', args.writeAccess);
    await runPackage({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      output: args.output,
      shotIds: args.shotIds,
    });
    return;
  }

  if (args.command === 'previs') {
    if (!args.manifest) throw new Error('--manifest is required for previs');
    if (args.resetProject) {
      requireExplicitWrite('previs --reset-project', args.writeAccess);
    }
    const result = await runPrevisCli({
      manifestPath: args.manifest,
      url: args.url,
      headless: args.headless || process.env.CI === 'true' || !process.stdout.isTTY,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      resetProject: args.resetProject,
      updateManifest: args.updateManifest,
      initializeOnly: args.initializeOnly,
      outputDir: args.output ?? 'artifacts/previs',
      skipPackage: args.skipPackage,
      profileDir: args.profile,
      allowHeavyCharacterImports: args.allowHeavyCharacterImports,
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === 'render-stills') {
    requireExplicitWrite('render-stills', args.writeAccess);
    const result = await runRenderStillsCli({
      url: args.url,
      headless: args.headless || process.env.CI === 'true' || !process.stdout.isTTY,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      outputDir: args.output ?? 'artifacts/previs',
      profileDir: args.profile,
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === 'contact-sheet') {
    if (!args.input) throw new Error('--input is required for contact-sheet');
    if (!args.output) throw new Error('--output is required for contact-sheet');
    const result = await runContactSheetCli({
      inputDir: args.input,
      outputPath: args.output,
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
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
