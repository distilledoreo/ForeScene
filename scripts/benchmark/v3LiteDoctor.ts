import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitIdentity, type GitIdentityRecord } from './git';
import type { BenchmarkFailure } from './types';
import type { BenchmarkRunLayout } from './layout';
import { preflightProductionAssets } from '../../src/engine/previs/assetPreflight';
import { parsePrevisProductionManifest } from '../../src/engine/previs/manifestValidation';
import {
  doctorCheck,
  doctorFailure,
  nonemptyFile,
  verifyHostedApp,
  verifyIsolatedProfile,
  verifyNonMutatingInspect,
  verifyRepository,
  type DoctorCheck,
  type DoctorInspectCli,
} from './doctorCore';
import {
  loadV3LiteContract,
  resolveV3LiteInputPath,
  resolveV3LiteManifestAssets,
  type LoadedV3LiteContract,
} from './v3LiteContract';

export type { DoctorCheck };

export interface V3LiteDoctorReport {
  ok: boolean;
  checkedAt: string;
  contractPath: string;
  inputRoot: string;
  url: string;
  profileDir: string;
  checks: DoctorCheck[];
  cli?: DoctorInspectCli;
}

export interface V3LiteDoctorInput {
  contractPath: string;
  inputRoot: string;
  url?: string;
  layout: BenchmarkRunLayout;
  loaded?: LoadedV3LiteContract;
  git?: GitIdentityRecord;
  fetchImpl?: typeof fetch;
  runCli?: Parameters<typeof verifyNonMutatingInspect>[0]['runCli'];
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
    return doctorCheck(`asset.${id}`, ok, ok ? `${id} is present (${filePath}).` : `Required ${id} is missing or empty: ${filePath}`);
  }));
  const preflight = await preflightProductionAssets(
    resolveV3LiteManifestAssets(loaded.manifest, inputRoot),
    normalizedManifestPath,
  );
  checks.push(doctorCheck('assets.preflight', preflight.ok,
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
  checks.push(doctorCheck('manifest.schema', Boolean(parsed.manifest) && parsed.errors.length === 0,
    parsed.errors.length === 0 ? 'Checked-in production manifest passes the ForeScene schema validator.' : parsed.errors.map((error) => error.message).join('; ')));
  const normalized = resolveV3LiteManifestAssets(loaded.manifest, inputRoot);
  await mkdir(path.dirname(normalizedManifestPath), { recursive: true });
  await writeFile(normalizedManifestPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  const normalizedParsed = parsePrevisProductionManifest(JSON.parse(await readFile(normalizedManifestPath, 'utf8')) as unknown);
  checks.push(doctorCheck('manifest.normalized', Boolean(normalizedParsed.manifest) && normalizedParsed.errors.length === 0,
    normalizedParsed.errors.length === 0 ? 'Resolved production manifest passes schema validation.' : normalizedParsed.errors.map((error) => error.message).join('; ')));
  checks.push(doctorCheck('manifest.shots', loaded.manifest.shots.map((shot) => shot.shotNumber).join(',') === '01,02,03', 'Frozen production manifest preserves shots 01, 02, and 03.'));
  checks.push(doctorCheck('manifest.motion', loaded.manifest.shots[1]?.motion?.durationSeconds === 3
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
  checks.push(await verifyRepository(git));
  checks.push(doctorCheck(
    'input-root.present',
    await nonemptyFile(resolveV3LiteInputPath(inputRoot, loaded.contract.basePackage, 'basePackage')),
    `Frozen input root is available: ${inputRoot}`,
  ));
  if (url) checks.push(await verifyHostedApp(url, input.fetchImpl ?? fetch));
  else checks.push(doctorCheck('hosted-app.responsive', false, 'FORESCENE_URL or --url is required for Benchmark V3-Lite.'));
  checks.push(...await verifyFrozenManifest(loaded, inputRoot, path.join(input.layout.harnessDir, 'production-manifest.json')));
  checks.push(...await verifyAssets(loaded, inputRoot, path.join(input.layout.harnessDir, 'production-manifest.json')));
  checks.push(await verifyIsolatedProfile(input.layout));

  const inspect = await verifyNonMutatingInspect({
    url,
    layout: input.layout,
    setupOk: checks.every((item) => item.ok),
    runCli: input.runCli,
  });
  checks.push(inspect.check);

  const report: V3LiteDoctorReport = {
    ok: checks.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    contractPath: path.resolve(input.contractPath),
    inputRoot,
    url,
    profileDir: input.layout.profileDir,
    checks,
    ...(inspect.cli ? { cli: inspect.cli } : {}),
  };
  await writeFile(input.layout.doctorPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report.ok
    ? { report }
    : { report, failure: doctorFailure('Benchmark V3-Lite', checks) };
}
