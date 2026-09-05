import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface V3AgentComparePair {
  left: string;
  right: string;
  candidatePlan: 'DIFFERENT' | 'IDENTICAL' | 'MISSING';
  productionManifest: 'DIFFERENT' | 'IDENTICAL' | 'MISSING';
  contactSheet: 'DIFFERENT' | 'IDENTICAL' | 'MISSING';
  requiredFrames: 'DIFFERENT' | 'IDENTICAL' | 'MISSING';
}

export interface V3AgentCompareReport {
  runs: string[];
  pairs: V3AgentComparePair[];
  collapse: boolean;
  warnings: string[];
  text: string;
}

const FRAME_FILES = [
  'creature-final.png',
  'chase-start.png',
  'chase-mid.png',
  'chase-end.png',
  'fighter-final.png',
];

async function fileHash(filePath: string): Promise<string | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) return undefined;
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function compare(left?: string, right?: string): 'DIFFERENT' | 'IDENTICAL' | 'MISSING' {
  if (!left || !right) return 'MISSING';
  return left === right ? 'IDENTICAL' : 'DIFFERENT';
}

async function runFingerprint(runRoot: string): Promise<{
  label: string;
  plan?: string;
  manifest?: string;
  contactSheet?: string;
  frames?: string;
}> {
  const resolved = path.resolve(runRoot);
  const label = path.basename(resolved);
  const plan = await fileHash(path.join(resolved, 'candidate', 'candidate-plan.json'))
    ?? ((await readFile(path.join(resolved, 'harness', 'candidate-plan.sha256'), 'utf8').catch(() => '')).trim() || undefined);
  const manifest = await fileHash(path.join(resolved, 'harness', 'candidate-production-manifest.json'))
    ?? ((await readFile(path.join(resolved, 'harness', 'candidate-manifest.sha256'), 'utf8').catch(() => '')).trim() || undefined);
  const artifactDir = (await stat(path.join(resolved, 'artifacts')).then((info) => info.isDirectory()).catch(() => false))
    ? path.join(resolved, 'artifacts')
    : path.join(resolved, 'work', 'artifacts');
  const contactSheet = await fileHash(path.join(artifactDir, 'contact-sheet.png'));
  const frameHashes = await Promise.all(FRAME_FILES.map((file) => fileHash(path.join(artifactDir, file))));
  const frames = frameHashes.every(Boolean) ? frameHashes.join('|') : undefined;
  return { label, plan, manifest, contactSheet, frames };
}

export async function compareV3AgentRuns(runRoots: string[]): Promise<V3AgentCompareReport> {
  if (runRoots.length < 2) throw new Error('benchmark:compare requires at least two run roots.');
  const fingerprints = await Promise.all(runRoots.map((root) => runFingerprint(root)));
  const pairs: V3AgentComparePair[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      const left = fingerprints[i]!;
      const right = fingerprints[j]!;
      const pair: V3AgentComparePair = {
        left: left.label,
        right: right.label,
        candidatePlan: compare(left.plan, right.plan),
        productionManifest: compare(left.manifest, right.manifest),
        contactSheet: compare(left.contactSheet, right.contactSheet),
        requiredFrames: compare(left.frames, right.frames),
      };
      pairs.push(pair);
      if (pair.candidatePlan === 'IDENTICAL' || pair.requiredFrames === 'IDENTICAL' || pair.contactSheet === 'IDENTICAL') {
        warnings.push(`WARNING: benchmark-collapse detected (${left.label} vs ${right.label})`);
      }
    }
  }
  const lines = [
    'Candidate plan:',
    ...pairs.map((pair) => `${pair.left} vs ${pair.right}: ${pair.candidatePlan}`),
    '',
    'Production manifest:',
    ...pairs.map((pair) => `${pair.left} vs ${pair.right}: ${pair.productionManifest}`),
    '',
    'Contact sheet:',
    ...pairs.map((pair) => `${pair.left} vs ${pair.right}: ${pair.contactSheet}`),
    '',
    'Required frames:',
    ...pairs.map((pair) => `${pair.left} vs ${pair.right}: ${pair.requiredFrames}`),
    ...(warnings.length > 0 ? ['', ...warnings] : []),
    '',
  ];
  return {
    runs: fingerprints.map((item) => item.label),
    pairs,
    collapse: warnings.length > 0,
    warnings,
    text: lines.join('\n'),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const report = await compareV3AgentRuns(argv);
  process.stdout.write(`${report.text}\n`);
  return 0;
}

const entry = process.argv[1];
if (entry && (path.resolve(entry) === fileURLToPath(import.meta.url) || entry.replaceAll('\\', '/').endsWith('scripts/benchmark/v3AgentCompare.ts'))) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
