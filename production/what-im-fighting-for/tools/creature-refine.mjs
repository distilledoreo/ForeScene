/**
 * Import real nonhumanoid creature GLBs into a live ForeScene project via the
 * ordinary model-import UI, align them to composition proxies, hide proxies per
 * shot, and optionally rerender affected frames.
 *
 * Does NOT reset the project. Requires an existing previs project with spider /
 * hand_monster proxy props already placed.
 *
 * Usage:
 *   node production/what-im-fighting-for/tools/creature-refine.mjs \
 *     --url https://forescene.distilledlabs.org \
 *     --profile .forescene-agent/music-video-v2-pilot \
 *     --output artifacts/music-video/pilot \
 *     --write
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

function parseArgs(argv) {
  const args = {
    url: process.env.FORESCENE_URL ?? 'https://forescene.distilledlabs.org',
    profile: '.forescene-agent/music-video-v2-pilot',
    output: 'artifacts/music-video/pilot',
    write: false,
    headless: false,
    spider: path.resolve(REPO_ROOT, 'artifacts/music-video/source/assets/Mutant_Spider.glb'),
    handMonster: path.resolve(REPO_ROOT, 'artifacts/music-video/source/assets/Hand_Monster_v3.glb'),
    skipImport: false,
    skipRender: false,
    shotNumbers: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--url') args.url = argv[++i];
    else if (t === '--profile') args.profile = argv[++i];
    else if (t === '--output') args.output = argv[++i];
    else if (t === '--write') args.write = true;
    else if (t === '--headless') args.headless = true;
    else if (t === '--spider') args.spider = path.resolve(REPO_ROOT, argv[++i]);
    else if (t === '--hand-monster') args.handMonster = path.resolve(REPO_ROOT, argv[++i]);
    else if (t === '--skip-import') args.skipImport = true;
    else if (t === '--skip-render') args.skipRender = true;
    else if (t === '--shots') args.shotNumbers = argv[++i].split(',').map((s) => s.trim());
  }
  return args;
}

async function dismissOverlays(page) {
  for (const label of ['Got it', 'Not right now', 'Start checking', 'Dismiss', 'Close']) {
    const button = page.getByRole('button', { name: label, exact: true });
    if (await button.isVisible().catch(() => false)) {
      await button.click({ force: true }).catch(() => undefined);
    }
  }
  const splash = page.getByRole('dialog', { name: /splash/i });
  if (await splash.isVisible().catch(() => false)) {
    await splash.click({ force: true }).catch(() => undefined);
  }
}

async function openBuild(page) {
  const build = page.locator('header nav button').filter({ hasText: /^\s*Build\s*$/ }).locator('visible=true').first();
  if (await build.isVisible().catch(() => false)) {
    await build.click();
    await page.waitForTimeout(400);
  }
  await dismissOverlays(page);
}

async function importOrdinaryModel(page, modelPath, { combined = true, allowHeavy = true } = {}) {
  await openBuild(page);
  await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
  await page.locator('[data-build-import-model]').click();
  const dialog = page.getByRole('dialog', { name: /Import 3D/ });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });

  if (combined) {
    const combinedMode = dialog.locator('[data-import-mode="combined"]');
    if (await combinedMode.count()) await combinedMode.check().catch(() => undefined);
  }
  if (allowHeavy) {
    const heavy = dialog.locator('[data-allow-heavy-imports]');
    if (await heavy.count()) await heavy.check().catch(() => undefined);
  }

  const beforeIds = await page.evaluate(() => {
    return window.foreScene.listObjects().map((o) => o.id);
  });

  await dialog.locator('[data-model-import-input]').setInputFiles(modelPath, { timeout: 120_000 });

  const success = dialog.locator('[data-model-import-report-item="success"]').last();
  const analysis = dialog.locator('[data-model-import-analysis]');
  await Promise.race([
    success.waitFor({ state: 'visible', timeout: 900_000 }),
    analysis.waitFor({ state: 'visible', timeout: 900_000 }),
  ]);

  if (await analysis.isVisible().catch(() => false)) {
    const extreme = dialog.locator('[data-extreme-import-confirmation]');
    if (await extreme.isVisible().catch(() => false)) await extreme.fill('IMPORT');
    const confirm = dialog.getByRole('button', { name: /Import (heavy|extreme) scene/i });
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await success.waitFor({ state: 'visible', timeout: 1_800_000 });
    }
  }

  const reportText = await success.innerText().catch(() => '');
  await dialog.getByText('Close', { exact: true }).last().click().catch(async () => {
    await page.keyboard.press('Escape');
  });
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await window.foreScene.waitForIdle({ timeoutMs: 120_000 });
  });

  const after = await page.evaluate((before) => {
    const objects = window.foreScene.listObjects();
    const created = objects.filter((o) => !before.includes(o.id));
    return created.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type,
      visible: o.visible,
    }));
  }, beforeIds);

  return { reportText, created: after };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.write) {
    console.error('creature-refine requires --write');
    process.exit(1);
  }

  const profileDir = path.isAbsolute(args.profile)
    ? args.profile
    : path.resolve(REPO_ROOT, args.profile);
  const outputDir = path.isAbsolute(args.output)
    ? args.output
    : path.resolve(REPO_ROOT, args.output);
  await mkdir(path.join(outputDir, 'logs'), { recursive: true });
  await mkdir(path.join(outputDir, 'shots'), { recursive: true });
  await mkdir(path.join(outputDir, 'temporal'), { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: args.headless,
    viewport: { width: 1600, height: 1000 },
  });

  await context.addInitScript(() => {
    try { window.localStorage.setItem('forescene-splash-seen', '1'); } catch { /* ignore */ }
    try {
      window.localStorage.removeItem('forescene-agent-control');
      window.sessionStorage.setItem('forescene-agent-control-session', 'read-write');
    } catch { /* ignore */ }
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await dismissOverlays(page);

  await page.waitForFunction(() => {
    const s = window.foreScene?.getStatus();
    return Boolean(s?.ready && s.projectLoaded && s.persistence?.ready);
  }, { timeout: 120_000 });

  const status = await page.evaluate(() => window.foreScene.getStatus());
  console.error(`[creature-refine] project=${status.projectName} id=${status.projectId} write=${status.writeAccess}`);

  if (!status.writeAccess) {
    // Try UI enable
    const enable = page.getByRole('button', { name: /Enable Agent Writes/i });
    if (await enable.isVisible().catch(() => false)) await enable.click();
  }

  await page.evaluate(async () => {
    await window.foreScene.waitForIdle({ timeoutMs: 60_000 });
  });

  // Locate proxies by name (stable across re-runs)
  const proxies = await page.evaluate(() => {
    const find = (needle) => {
      const list = window.foreScene.listObjects({ name: needle, match: 'contains' });
      return list.map((o) => {
        const detail = window.foreScene.inspectObject({ id: o.id });
        return {
          id: o.id,
          name: o.name,
          type: o.type,
          transform: detail.transform,
          dimensions: detail.dimensions,
        };
      });
    };
    return {
      spider: find('Spider'),
      handMonster: find('Hand Monster'),
    };
  });

  console.error('[creature-refine] proxies', JSON.stringify(proxies, null, 2));

  const spiderProxy = proxies.spider.find((p) => /proxy|Original Spider/i.test(p.name))
    ?? proxies.spider[0];
  const monsterProxy = proxies.handMonster.find((p) => /proxy|Hand Monster/i.test(p.name))
    ?? proxies.handMonster[0];

  if (!spiderProxy || !monsterProxy) {
    console.error('Missing spider or hand_monster proxy objects. Aborting.');
    console.error(JSON.stringify({ proxies }, null, 2));
    await context.close();
    process.exit(1);
  }

  let spiderReal = null;
  let monsterReal = null;
  const importLog = { imports: [], applied: null, shots: [] };

  if (!args.skipImport) {
    // Avoid re-import if already present from a prior refine
    const existing = await page.evaluate(() => {
      const all = window.foreScene.listObjects();
      return {
        spider: all.filter((o) => /Mutant_Spider|Real Spider|spider_real/i.test(o.name)),
        monster: all.filter((o) => /Hand_Monster|Real Hand Monster|hand_monster_real/i.test(o.name)),
      };
    });

    if (existing.spider.length === 0) {
      console.error('[creature-refine] importing spider GLB…');
      const result = await importOrdinaryModel(page, args.spider, { combined: true, allowHeavy: true });
      importLog.imports.push({ kind: 'spider', ...result });
      spiderReal = result.created[0] ?? null;
      if (spiderReal) {
        await page.evaluate(async ({ id, name }) => {
          await window.foreScene.applyPlan({
            version: 1,
            planId: 'rename-spider-real',
            description: 'Rename imported spider',
            commands: [{ op: 'object.update', object: { id }, updates: { name } }],
          });
        }, { id: spiderReal.id, name: 'Mutant Spider (real)' });
        spiderReal.name = 'Mutant Spider (real)';
      }
    } else {
      spiderReal = existing.spider[0];
      console.error('[creature-refine] reusing spider', spiderReal.id);
    }

    if (existing.monster.length === 0) {
      console.error('[creature-refine] importing hand monster GLB…');
      const result = await importOrdinaryModel(page, args.handMonster, { combined: true, allowHeavy: true });
      importLog.imports.push({ kind: 'hand_monster', ...result });
      monsterReal = result.created[0] ?? null;
      if (monsterReal) {
        await page.evaluate(async ({ id, name }) => {
          await window.foreScene.applyPlan({
            version: 1,
            planId: 'rename-monster-real',
            description: 'Rename imported hand monster',
            commands: [{ op: 'object.update', object: { id }, updates: { name } }],
          });
        }, { id: monsterReal.id, name: 'Hand Monster (real)' });
        monsterReal.name = 'Hand Monster (real)';
      }
    } else {
      monsterReal = existing.monster[0];
      console.error('[creature-refine] reusing hand monster', monsterReal.id);
    }
  } else {
    const existing = await page.evaluate(() => {
      const all = window.foreScene.listObjects();
      return {
        spider: all.find((o) => /Mutant Spider \(real\)|Mutant_Spider/i.test(o.name)),
        monster: all.find((o) => /Hand Monster \(real\)|Hand_Monster/i.test(o.name)),
      };
    });
    spiderReal = existing.spider;
    monsterReal = existing.monster;
  }

  if (!spiderReal || !monsterReal) {
    console.error('Failed to resolve real creature object IDs', { spiderReal, monsterReal });
    await writeFile(path.join(outputDir, 'logs', 'creature-import.json'), JSON.stringify(importLog, null, 2));
    await context.close();
    process.exit(1);
  }

  // Align real models to proxy base transforms and hide globally (per-shot stage shows them)
  const align = await page.evaluate(async ({ spiderProxy, monsterProxy, spiderRealId, monsterRealId }) => {
    const spiderT = spiderProxy.transform;
    const monsterT = monsterProxy.transform;
    // Scale proxies were composition-sized boxes; real GLBs may need approx unit scale.
    // Start with proxy scale; if bounds are wild the operator can nudge later.
    return window.foreScene.applyPlan({
      version: 1,
      planId: 'align-real-creatures',
      description: 'Place real spider/hand-monster at proxy transforms; hide proxies at scene default',
      commands: [
        {
          op: 'object.update',
          object: { id: spiderRealId },
          updates: {
            visible: false,
            transform: {
              position: spiderT.position,
              rotation: spiderT.rotation,
              scale: spiderT.scale,
            },
          },
        },
        {
          op: 'object.update',
          object: { id: monsterRealId },
          updates: {
            visible: false,
            transform: {
              position: monsterT.position,
              rotation: monsterT.rotation,
              scale: monsterT.scale,
            },
          },
        },
        {
          op: 'object.update',
          object: { id: spiderProxy.id },
          updates: { visible: true }, // keep base; hide per-shot
        },
        {
          op: 'object.update',
          object: { id: monsterProxy.id },
          updates: { visible: true },
        },
      ],
    });
  }, {
    spiderProxy,
    monsterProxy,
    spiderRealId: spiderReal.id,
    monsterRealId: monsterReal.id,
  });

  importLog.applied = {
    align,
    spiderReal,
    monsterReal,
    spiderProxy: { id: spiderProxy.id, name: spiderProxy.name, transform: spiderProxy.transform },
    monsterProxy: { id: monsterProxy.id, name: monsterProxy.name, transform: monsterProxy.transform },
  };

  // Per-shot: hide proxies, show reals at staged proxy transforms from shot overrides if any
  const shotPlan = await page.evaluate(async ({
    spiderProxyId,
    monsterProxyId,
    spiderRealId,
    monsterRealId,
    spiderProxyTransform,
    monsterProxyTransform,
    filterShots,
  }) => {
    const shots = window.foreScene.listShots();
    const commands = [];
    const affected = [];

    for (const shot of shots) {
      if (filterShots && !filterShots.includes(shot.shotNumber) && !filterShots.includes(String(Number(shot.shotNumber)))) {
        continue;
      }
      const detail = window.foreScene.inspectShot({ id: shot.id });
      const overrides = detail.objectOverrides ?? {};
      // Prefer staged proxy overrides (composition truth). Fall back to conservative name match.
      const text = `${shot.name ?? ''} ${shot.description ?? ''}`.toLowerCase();
      const wantSpider = Boolean(overrides[spiderProxyId])
        || /\bspider\b/.test(text)
        || /mutant spider|original spider/.test(text);
      const wantMonster = Boolean(overrides[monsterProxyId])
        || /\bhand monster\b|\bh[0-4]\b|\bnewborn\b|\bpounce\b|\bcorpse\b/.test(text)
        || /hand creature|monster dies|monster pov|finger breach|first exchange|predictive combat|mirrored stances|left arm pinned|discard shield|final non-graphic|sprint chase/.test(text);

      if (!wantSpider && !wantMonster) continue;
      affected.push({
        shotId: shot.id,
        shotNumber: shot.shotNumber,
        name: shot.name,
        wantSpider,
        wantMonster,
      });

      if (wantSpider) {
        const ov = overrides[spiderProxyId];
        const t = ov?.transform ?? spiderProxyTransform;
        commands.push({
          op: 'shot.stageObject',
          shot: { id: shot.id },
          object: { id: spiderProxyId },
          visible: false,
        });
        commands.push({
          op: 'shot.stageObject',
          shot: { id: shot.id },
          object: { id: spiderRealId },
          visible: true,
          transform: {
            position: t.position ?? spiderProxyTransform.position,
            rotation: t.rotation ?? spiderProxyTransform.rotation,
            scale: t.scale ?? spiderProxyTransform.scale,
          },
        });
      }
      if (wantMonster) {
        const ov = overrides[monsterProxyId];
        const t = ov?.transform ?? monsterProxyTransform;
        commands.push({
          op: 'shot.stageObject',
          shot: { id: shot.id },
          object: { id: monsterProxyId },
          visible: false,
        });
        commands.push({
          op: 'shot.stageObject',
          shot: { id: shot.id },
          object: { id: monsterRealId },
          visible: true,
          transform: {
            position: t.position ?? monsterProxyTransform.position,
            rotation: t.rotation ?? monsterProxyTransform.rotation,
            scale: t.scale ?? monsterProxyTransform.scale,
          },
        });
      }

      // Motion: if shot has timeline, add creature transform keyframes at start/end
      const timeline = window.foreScene.inspectShotTimeline({ id: shot.id });
      if (timeline?.keyframes?.length >= 2 && wantMonster) {
        const first = timeline.keyframes[0];
        const last = timeline.keyframes[timeline.keyframes.length - 1];
        const base = overrides[monsterProxyId]?.transform ?? monsterProxyTransform;
        const startPos = base.position ?? monsterProxyTransform.position;
        // Coarse chase/attack offset along +Z for endpoint (blocking guidance only)
        const endPos = [
          startPos[0] + (wantSpider ? 0 : -0.4),
          startPos[1],
          startPos[2] + (wantSpider ? 0 : 1.2),
        ];
        commands.push({
          op: 'shot.keyframe.stageObject',
          shot: { id: shot.id },
          keyframe: { id: first.id },
          object: { id: monsterRealId },
          visible: true,
          transform: {
            position: startPos,
            rotation: base.rotation ?? monsterProxyTransform.rotation,
            scale: base.scale ?? monsterProxyTransform.scale,
          },
        });
        commands.push({
          op: 'shot.keyframe.stageObject',
          shot: { id: shot.id },
          keyframe: { id: last.id },
          object: { id: monsterRealId },
          visible: true,
          transform: {
            position: endPos,
            rotation: base.rotation ?? monsterProxyTransform.rotation,
            scale: base.scale ?? monsterProxyTransform.scale,
          },
        });
        commands.push({
          op: 'shot.keyframe.stageObject',
          shot: { id: shot.id },
          keyframe: { id: first.id },
          object: { id: monsterProxyId },
          visible: false,
        });
        commands.push({
          op: 'shot.keyframe.stageObject',
          shot: { id: shot.id },
          keyframe: { id: last.id },
          object: { id: monsterProxyId },
          visible: false,
        });
      }
    }

    if (commands.length === 0) {
      return { ok: true, affected, summary: { commandCount: 0 } };
    }

    // Batch apply in chunks to avoid huge plans
    const chunkSize = 40;
    const results = [];
    for (let i = 0; i < commands.length; i += chunkSize) {
      const chunk = commands.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      const r = await window.foreScene.applyPlan({
        version: 1,
        planId: `creature-shot-staging-${i}`,
        description: 'Stage real creatures; hide proxies on creature shots',
        commands: chunk,
      });
      results.push(r);
      if (!r.ok) break;
    }
    return { ok: results.every((r) => r.ok), affected, results, commandCount: commands.length };
  }, {
    spiderProxyId: spiderProxy.id,
    monsterProxyId: monsterProxy.id,
    spiderRealId: spiderReal.id,
    monsterRealId: monsterReal.id,
    spiderProxyTransform: spiderProxy.transform,
    monsterProxyTransform: monsterProxy.transform,
    filterShots: args.shotNumbers,
  });

  importLog.shots = shotPlan;
  await writeFile(
    path.join(outputDir, 'logs', 'creature-import.json'),
    `${JSON.stringify(importLog, null, 2)}\n`,
  );
  console.error(`[creature-refine] staged ${shotPlan.commandCount ?? 0} commands on ${shotPlan.affected?.length ?? 0} shots ok=${shotPlan.ok}`);

  if (!args.skipRender && shotPlan.affected?.length) {
    for (const shot of shotPlan.affected) {
      const shotId = shot.shotId ?? shot.id;
      if (!shotId) {
        console.error(`[creature-refine] missing shot id for ${shot.shotNumber}`, shot);
        continue;
      }
      console.error(`[creature-refine] render shot ${shot.shotNumber} (${shotId})…`);
      // eslint-disable-next-line no-await-in-loop
      const frame = await page.evaluate(async (id) => {
        await window.foreScene.waitForIdle({ timeoutMs: 60_000 });
        try {
          await window.foreScene.waitForViewportReady?.({ workspace: 'shots', shotId: id });
        } catch {
          // optional
        }
        return window.foreScene.renderShotFrame({ shotId: id, timeSeconds: 0, pass: 'clay' });
      }, shotId);

      if (frame?.ok && frame.pngDataUrl) {
        const buf = Buffer.from(frame.pngDataUrl.split(',')[1], 'base64');
        const outPath = path.join(outputDir, 'shots', `${shot.shotNumber}.png`);
        // eslint-disable-next-line no-await-in-loop
        await writeFile(outPath, buf);
        console.error(`[creature-refine] wrote ${outPath}`);
      } else {
        console.error(`[creature-refine] frame failed for ${shot.shotNumber}`, frame?.error ?? frame);
      }

      // Temporal samples for motion shots
      // eslint-disable-next-line no-await-in-loop
      const timeline = await page.evaluate((id) => window.foreScene.inspectShotTimeline({ id }), shotId);
      if (timeline?.durationSeconds > 0 && timeline.keyframes?.length >= 2) {
        const times = [0, timeline.durationSeconds / 2, timeline.durationSeconds];
        for (const t of times) {
          // eslint-disable-next-line no-await-in-loop
          const sample = await page.evaluate(
            async ({ id, timeSeconds }) => window.foreScene.renderShotFrame({ shotId: id, timeSeconds, pass: 'clay' }),
            { id: shotId, timeSeconds: t },
          );
          if (sample?.ok && sample.pngDataUrl) {
            const label = String(t).replace('.', '_');
            const p = path.join(outputDir, 'temporal', `${shot.shotNumber}-${label}s.png`);
            // eslint-disable-next-line no-await-in-loop
            await writeFile(p, Buffer.from(sample.pngDataUrl.split(',')[1], 'base64'));
          }
        }
      }
    }
  }

  const summary = {
    ok: Boolean(shotPlan.ok && spiderReal && monsterReal),
    projectId: status.projectId,
    projectName: status.projectName,
    spiderRealId: spiderReal.id,
    monsterRealId: monsterReal.id,
    spiderProxyId: spiderProxy.id,
    monsterProxyId: monsterProxy.id,
    affectedShots: shotPlan.affected,
    logPath: path.join(outputDir, 'logs', 'creature-import.json'),
  };
  await writeFile(path.join(outputDir, 'logs', 'creature-refine-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  await context.close();
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
