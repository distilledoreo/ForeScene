import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { runDocumentedAgentCommand } from '../scripts/agent/runDocumentedCli';
import type { AgentVisualPreflightResult } from '../src/engine/agent/protocol';
import { visualValidationProject } from '../tests/fixtures/visualValidationProject';

test('public visual validation detects failures, corrects grounding and survives reopen @agent-visual-validation @agent-cli @smoke', async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The Agent CLI owns its Chromium profile.');
  test.setTimeout(8 * 60_000);
  const workDir = testInfo.outputPath('visual-validation');
  await mkdir(workDir, { recursive: true });
  const profile = path.join(workDir, 'profile');
  const freshProfile = path.join(workDir, 'reopened');
  const { project, shot, subject, dressing } = visualValidationProject();
  subject.transform.position[1] = 0; // Real half-buried input, not a validator false positive.
  const fixture = new JSZip().file('project.json', JSON.stringify(project));
  const inputPath = path.join(workDir, 'input.fsp');
  await writeFile(inputPath, await fixture.generateAsync({ type: 'nodebuffer' }));

  let sequence = 0;
  const run = async (command: string, args: string[], expectedCode = 0, selectedProfile = profile) => {
    const result = await runDocumentedAgentCommand({ command, args, url: baseURL,
      profile: selectedProfile, repoRoot: process.cwd(), cwd: workDir, timeoutMs: 120_000 });
    await writeFile(path.join(workDir, `${++sequence}-${command}.json`), JSON.stringify(result, null, 2));
    expect(result.code, result.stderr + result.stdout).toBe(expectedCode);
    expect(result.envelope).toBeTruthy();
    return result.envelope!;
  };
  const selection = ['--shots', '01', '--subjects', subject.id,
    '--environment-objects', dressing.id, '--appearance', 'projected'];
  const verify = async (command: 'verify' | 'visual-preflight', expectedCode: number, selectedProfile = profile, extra: string[] = []) => {
    const envelope = await run(command, [...selection, ...extra], expectedCode, selectedProfile);
    const result = envelope.result as { visualPreflight: AgentVisualPreflightResult[] };
    expect(result.visualPreflight).toHaveLength(1);
    return result.visualPreflight[0]!;
  };
  const stage = async (y: number, visible = true) => {
    const plan = path.join(workDir, 'stage.json');
    await writeFile(plan, JSON.stringify({ version: 1, commands: [{ op: 'shot.stageObject',
      shot: { id: shot.id }, object: { id: subject.id }, visible,
      transform: { position: [0, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }] }));
    await run('preview', ['--plan', plan]);
    await run('apply', ['--plan', plan, '--write']);
  };

  await run('open', ['--file', inputPath, '--write']);
  const buried = await verify('verify', 1);
  expect(buried.checks.find((c) => c.id === 'ground_contact')?.status).toBe('failed');
  expect(buried.subjects[0]?.groundClearanceMeters).toBeCloseTo(-0.5);
  await stage(1.2);
  const floating = await verify('visual-preflight', 1);
  expect(floating.checks.find((c) => c.id === 'ground_contact')?.status).toBe('failed');
  expect(floating.subjects[0]?.groundClearanceMeters).toBeCloseTo(0.7);
  await stage(0.5, false);
  const hidden = await verify('verify', 1, profile, ['--environment-objects', subject.id]);
  expect(hidden.missingSubjectIds).toContain(subject.id);
  await stage(0.5);
  const missing = await verify('visual-preflight', 1, profile, ['--subjects', 'missing-subject']);
  expect(missing.missingSubjectIds).toContain('missing-subject');
  const corrected = await verify('verify', 0);
  expect(corrected.gateStatus).toBe('passed');
  expect(corrected.appearance).toBe('projected');
  expect(corrected.subjects[0]?.groundClearanceMeters).toBeCloseTo(0);
  expect(corrected.subjects[0]?.visibleFraction).toBe(1);

  const savedPath = path.join(workDir, 'corrected.fsp');
  await run('save', ['--output', savedPath, '--write']);
  const saved = await JSZip.loadAsync(await readFile(savedPath));
  const document = JSON.parse(await saved.file('project.json')!.async('text'));
  expect(document.shots[0].objectOverrides[subject.id].transform.position[1]).toBe(0.5);
  await run('open', ['--file', savedPath, '--write'], 0, freshProfile);
  expect((await verify('visual-preflight', 0, freshProfile)).gateStatus).toBe('passed');
  const framePath = path.join(workDir, 'corrected-projected.png');
  await run('frame', ['--shot', '01', '--mode', 'projected', '--output', framePath], 0, freshProfile);
  expect((await readFile(framePath)).byteLength).toBeGreaterThan(1000);
  await testInfo.attach('corrected-projected', { path: framePath, contentType: 'image/png' });
  // The same wall really occludes the crate in clay. Environment labels do not override it.
  const clay = await verify('visual-preflight', 1, freshProfile, ['--appearance', 'clay']);
  expect(clay.subjects[0]?.occlusionRatio).toBe(1);
});
