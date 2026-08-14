import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDefaultAgentProfilePath } from '../agent/agentProfile';
import { invokeAgentCli, type AgentCliInvocation } from './agentCli';
import { gitIdentity, type GitIdentityRecord } from './git';
import { environmentFailure } from './failures';
import type { BenchmarkFailure } from './types';
import type { BenchmarkRunLayout } from './layout';
import { repoRoot } from './layout';
import { preflightProductionAssets } from '../../src/engine/previs/assetPreflight';
import { parsePrevisProductionManifest } from '../../src/engine/previs/manifestValidation';
import {
  loadV3LiteContract,
  resolveV3LiteInputPath,
  resolveV3LiteManifestAssets,
  type LoadedV3LiteContract,
} from './v3LiteContract';

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface V3LiteDoctorReport {
  ok: boolean;
  checkedAt: string;
  contractPath: string;
  inputRoot: string;
  url: string;
  profileDir: string;
  checks: DoctorCheck[];
  cli?: {
    command: 'inspect';
    code: number;
    durationMs?: number;
    operation?: string;
  };
}

export interface V3LiteDoctorInput {
  contractPath: string;
  inputRoot: string;
  url?: string;
  layout: BenchmarkRunLayout;
  loaded?: LoadedV3LiteContract;
  git?: GitIdentityRecord;
  fetchImpl?: typeof fetch;
  runCli?: (input: {
    repoRoot: string;
    args: string[];
    url: string;
    profile: string;
    timeoutMs?: number;
  }) => Promise<AgentCliInvocation>;
}

function check(id: string, ok: boolean, message: string): DoctorCheck {
  return { id, ok, message };
}

async function nonemptyFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function verifyHostedApp(url: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    const recognizable = body.includes('ForeScene') || body.includes('id="root"') || body.includes("id='root'");
    return check('hosted-app.responsive', response.ok && recognizable,
      response.ok && recognizable
        ? `Hosted ForeScene responded with HTTP ${response.status}.`
        : `Hosted URL responded with HTTP ${response.status}, but not recognizable ForeScene HTML.`);
  } catch (error) {
    return check('hosted-app.responsive', false, `Hosted ForeScene was not responsive: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyProfile(layout: BenchmarkRunLayout): Promise<DoctorCheck> {
  const profile = path.resolve(layout.profileDir);
  const runRoot = path.resolve(layout.runRoot);
  const relative = path.relative(runRoot, profile);
  const insideRun = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!insideRun || isDefaultAgentProfilePath(profile, repoRoot())) {
    return check('profile.isolated', false, `Profile is not an isolated run profile: ${profile}`);
  }
  const probe = path.join(profile, '.doctor-write-probe');
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(probe, 'doctor');
    await rm(probe, { force: true });
    return check('profile.usable', true, `Isolated profile is writable: ${profile}`);
  } catch (error) {
    return check('profile.usable', false, `Isolated profile is not usable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyGit(git: GitIdentityRecord): Promise<DoctorCheck> {
  const expected = git.expectedCommit ? ` expected ${git.expectedCommit}` : '';
  const ok = !git.dirty && Boolean(git.expectedCommitIsAncestor);
  return check('repository.clean', ok,
    ok
      ? `ForeScene repository is clean at ${git.commit}${expected}.`
      : `Refusing benchmark from dirty or unexpected ForeScene workspace (commit ${git.commit}).${git.dirty ? `\n${git.porcelain}` : ''}`);
}

async function verifyAssets(
  loaded: LoadedV3LiteContract,
  inputRoot: string,
  normalizedManifestPath: string,
): Promise<DoctorCheck[]> {
  const paths = new Map<string, string>();
  paths.set('base-package', resolveV3LiteInputPath(inputRoot, loaded.contract.basePackage, 'basePackage'));
  for (const character of loaded.manifest.cast) {
    if (character.type !== 'imported_character') continue;
    paths.set(`cast.${character.id}.source`, resolveV3LiteInputPath(inputRoot, character.source, `cast.${character.id}.source`));
    if (character.rigPackage) paths.set(`cast.${character.id}.rigPackage`, resolveV3LiteInputPath(inputRoot, character.rigPackage, `cast.${character.id}.rigPackage`));
  }
  for (const asset of loaded.manifest.assets ?? []) {
    if (asset.source) paths.set(`assets.${asset.id}.source`, resolveV3LiteInputPath(inputRoot, asset.source, `assets.${asset.id}.source`));
    if (asset.rigPackage) paths.set(`assets.${asset.id}.rigPackage`, resolveV3LiteInputPath(inputRoot, asset.rigPackage, `assets.${asset.id}.rigPackage`));
  }
  const checks = await Promise.all([...paths.entries()].map(async ([id, filePath]) => {
    const ok = await nonemptyFile(filePath);
    return check(`asset.${id}`, ok, ok ? `${id} is present (${filePath}).` : `Required ${id} is missing or empty: ${filePath}`);
  }));
  const preflight = await preflightProductionAssets(
    resolveV3LiteManifestAssets(loaded.manifest, inputRoot),
    normalizedManifestPath,
  );
  checks.push(check('assets.preflight', preflight.ok,
    preflight.ok ? 'All frozen production assets passed the product asset preflight.' : preflight.errors.map((error) => error.message).join('; ')));
  return checks;
}

async function verifyFrozenManifest(
  loaded: LoadedV3LiteContract,
  inputRoot: string,
  normalizedManifestPath: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const parsed = parsePrevisProductionManifest(loaded.manifest);
  checks.push(check('manifest.schema', Boolean(parsed.manifest) && parsed.errors.length === 0,
    parsed.errors.length === 0 ? 'Checked-in production manifest passes the ForeScene schema validator.' : parsed.errors.map((error) => error.message).join('; ')));
  const normalized = resolveV3LiteManifestAssets(loaded.manifest, inputRoot);
  await mkdir(path.dirname(normalizedManifestPath), { recursive: true });
  await writeFile(normalizedManifestPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  const normalizedParsed = parsePrevisProductionManifest(JSON.parse(await readFile(normalizedManifestPath, 'utf8')) as unknown);
  checks.push(check('manifest.normalized', Boolean(normalizedParsed.manifest) && normalizedParsed.errors.length === 0,
    normalizedParsed.errors.length === 0 ? 'Resolved production manifest passes schema validation.' : normalizedParsed.errors.map((error) => error.message).join('; ')));
  checks.push(check('manifest.shots', loaded.manifest.shots.map((shot) => shot.shotNumber).join(',') === '01,02,03', 'Frozen production manifest preserves shots 01, 02, and 03.'));
  checks.push(check('manifest.motion', loaded.manifest.shots[1]?.motion?.durationSeconds === 3
    && loaded.manifest.shots[1]?.motion?.keyframes.length === 3,
  'Frozen production manifest preserves the three-second start/mid/end motion contract.'));
  return checks;
}

export async function runV3LiteDoctor(input: V3LiteDoctorInput): Promise<{
  report: V3LiteDoctorReport;
  failure?: BenchmarkFailure;
}> {
  const loaded = input.loaded ?? await loadV3LiteContract(input.contractPath);
  const inputRoot = path.resolve(input.inputRoot);
  const url = input.url?.trim() ?? '';
  const checks: DoctorCheck[] = [];
  const git = input.git ?? await gitIdentity();
  checks.push(await verifyGit(git));
  checks.push(check('input-root.present', await nonemptyFile(resolveV3LiteInputPath(inputRoot, loaded.contract.basePackage, 'basePackage')), `Frozen input root is available: ${inputRoot}`));
  if (url) checks.push(await verifyHostedApp(url, input.fetchImpl ?? fetch));
  else checks.push(check('hosted-app.responsive', false, 'FORESCENE_URL or --url is required for Benchmark V3-Lite.'));
  checks.push(...await verifyFrozenManifest(loaded, inputRoot, path.join(input.layout.harnessDir, 'production-manifest.json')));
  checks.push(...await verifyAssets(loaded, inputRoot, path.join(input.layout.harnessDir, 'production-manifest.json')));
  checks.push(await verifyProfile(input.layout));

  let cli: V3LiteDoctorReport['cli'];
  const setupOk = checks.every((item) => item.ok);
  if (setupOk && url) {
    const invocation = await (input.runCli ?? ((cliInput) => invokeAgentCli(cliInput)))({
      repoRoot: repoRoot(),
      args: ['inspect'],
      url,
      profile: input.layout.profileDir,
      timeoutMs: 180_000,
    });
    cli = {
      command: 'inspect',
      code: invocation.code,
      durationMs: invocation.durationMs,
      operation: invocation.envelope?.operation,
    };
    checks.push(check('cli.non-mutating-inspect', invocation.code === 0 && Boolean(invocation.envelope),
      invocation.code === 0 && invocation.envelope ? 'Non-mutating Agent CLI inspect completed.' : `Non-mutating Agent CLI inspect failed with exit code ${invocation.code}.`));
  } else {
    checks.push(check('cli.non-mutating-inspect', false, 'Skipped because deterministic doctor setup checks already failed.'));
  }

  const report: V3LiteDoctorReport = {
    ok: checks.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    contractPath: path.resolve(input.contractPath),
    inputRoot,
    url,
    profileDir: input.layout.profileDir,
    checks,
    ...(cli ? { cli } : {}),
  };
  await writeFile(input.layout.doctorPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report.ok
    ? { report }
    : {
        report,
        failure: environmentFailure(`Benchmark V3-Lite doctor failed; candidate launch is blocked. ${checks.filter((item) => !item.ok).map((item) => item.message).join(' ')}`),
      };
}
