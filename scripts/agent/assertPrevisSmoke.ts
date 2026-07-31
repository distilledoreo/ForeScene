/**
 * Strong composition assertions for the four-shot minimal-dialogue smoke.
 * Reads artifacts written by agent:previs — no browser required.
 *
 * Usage:
 *   npx tsx scripts/agent/assertPrevisSmoke.ts --dir artifacts/previs
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

interface CompositionSubject {
  bounds?: {
    widthCoverage?: number;
    heightCoverage?: number;
    areaCoverage?: number;
    centerX?: number;
    centerY?: number;
  };
  landmarks?: Record<string, { x: number; y: number; inFrame: boolean }>;
  visible?: boolean;
  faceOccluded?: boolean;
}

interface CompositionFile {
  shotId?: string;
  shotNumber?: string;
  frameWidth?: number;
  frameHeight?: number;
  subjects?: Record<string, CompositionSubject>;
}

interface ValidationFile {
  results?: Array<{
    shotNumber: string;
    status: string;
    template?: string;
    issues?: Array<{ code: string; message?: string }>;
  }>;
}

interface SummaryFile {
  ok?: boolean;
  failed?: number;
  warnings?: number;
  passed?: number;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): never {
  console.error(`ASSERT FAIL: ${message}`);
  process.exit(1);
}

function subjectOf(
  composition: CompositionFile,
  keys: string[],
): CompositionSubject | undefined {
  const subjects = composition.subjects ?? {};
  for (const key of keys) {
    if (subjects[key]) return subjects[key];
    const found = Object.entries(subjects).find(([name]) => (
      name.toLowerCase() === key.toLowerCase()
      || name.toLowerCase().includes(key.toLowerCase())
    ));
    if (found) return found[1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const dirArgIndex = process.argv.indexOf('--dir');
  const dir = path.resolve(
    dirArgIndex >= 0 && process.argv[dirArgIndex + 1]
      ? process.argv[dirArgIndex + 1]!
      : 'artifacts/previs',
  );

  const summaryPath = path.join(dir, 'summary.json');
  const validationPath = path.join(dir, 'validation.json');
  if (!(await pathExists(summaryPath))) fail(`missing ${summaryPath}`);
  if (!(await pathExists(validationPath))) fail(`missing ${validationPath}`);

  const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as SummaryFile;
  const validation = JSON.parse(await readFile(validationPath, 'utf8')) as ValidationFile;

  if (summary.failed !== 0) {
    fail(`summary.failed === ${summary.failed}, expected 0`);
  }
  if ((summary.warnings ?? 0) !== 0) {
    fail(`summary.warnings === ${summary.warnings}, expected 0`);
  }
  if (summary.ok !== true) {
    fail('summary.ok is not true');
  }

  const results = validation.results ?? [];
  for (const shotNumber of ['010', '020', '030', '040']) {
    const result = results.find((item) => item.shotNumber === shotNumber);
    if (!result) fail(`validation missing shot ${shotNumber}`);
    if (result.status !== 'passed') {
      fail(
        `shot ${shotNumber} validation status is ${result.status}: `
        + `${(result.issues ?? []).map((i) => i.code).join(', ')}`,
      );
    }

    const png = path.join(dir, 'shots', `${shotNumber}.png`);
    const compositionPath = path.join(dir, 'shots', `${shotNumber}.composition.json`);
    if (!(await pathExists(png))) fail(`missing ${png}`);
    if (!(await pathExists(compositionPath))) fail(`missing ${compositionPath}`);
    // Production path must not be a UI debug file.
    if (png.includes(`${path.sep}debug${path.sep}`) || png.endsWith('-ui.png')) {
      fail(`production frame path looks like debug: ${png}`);
    }

    const header = Buffer.alloc(8);
    const fh = await readFile(png);
    fh.copy(header, 0, 0, 8);
    const sig = header.toString('hex');
    if (sig !== '89504e470d0a1a0a') fail(`${png} is not a valid PNG`);

    const composition = JSON.parse(await readFile(compositionPath, 'utf8')) as CompositionFile;
    assertShotComposition(shotNumber, composition);
  }

  if (!(await pathExists(path.join(dir, 'contact-sheet.png')))) {
    fail('missing contact-sheet.png');
  }

  console.log('ASSERT OK: four-shot composition and validation gates passed.');
}

function assertShotComposition(shotNumber: string, composition: CompositionFile): void {
  switch (shotNumber) {
    case '010': {
      const alex = subjectOf(composition, ['alex', 'Alex']);
      const blair = subjectOf(composition, ['blair', 'Blair']);
      if (!alex?.visible) fail('010: Alex not visible');
      if (!blair?.visible) fail('010: Blair not visible');
      const sep = Math.abs((alex.bounds?.centerX ?? 0.5) - (blair.bounds?.centerX ?? 0.5));
      if (sep < 0.10) fail(`010: horizontal separation too small (${sep.toFixed(3)})`);
      break;
    }
    case '020': {
      const alex = subjectOf(composition, ['alex', 'Alex']);
      if (!alex?.visible) fail('020: Alex not visible');
      const waistY = alex.landmarks?.waist?.y;
      const feetIn = alex.landmarks?.feet?.inFrame === true;
      if (waistY === undefined) fail('020: missing waist landmark');
      // Waist near bottom crop band for medium.
      if (waistY < 0.70 || waistY > 1.10) {
        fail(`020: Alex waist Y ${waistY.toFixed(3)} outside medium band [0.70, 1.10]`);
      }
      if (feetIn && (alex.landmarks?.feet?.y ?? 1) < 0.92) {
        fail('020: Alex feet still clearly in frame for medium');
      }
      // Secondary must not dominate.
      const blair = subjectOf(composition, ['blair', 'Blair']);
      if (blair?.visible && (blair.bounds?.areaCoverage ?? 0) > (alex.bounds?.areaCoverage ?? 0) * 0.45) {
        fail('020: Blair dominates over Alex');
      }
      break;
    }
    case '030': {
      const fg = subjectOf(composition, ['blair', 'Blair']);
      const prim = subjectOf(composition, ['alex', 'Alex']);
      if (!fg?.visible) fail('030: OTS foreground Blair not visible');
      if (!prim?.visible) fail('030: OTS primary Alex not visible');
      const width = fg.bounds?.widthCoverage ?? 0;
      if (width < 0.10 || width > 0.40) {
        fail(`030: foreground width ${width.toFixed(3)} outside [0.10, 0.40]`);
      }
      const centerX = fg.bounds?.centerX ?? 0.5;
      const touchesEdge = centerX < 0.32 || centerX > 0.68;
      if (!touchesEdge) {
        fail(`030: foreground centerX ${centerX.toFixed(3)} does not read as edge-hugging`);
      }
      if (prim.faceOccluded) fail('030: primary face occluded');
      break;
    }
    case '040': {
      const alex = subjectOf(composition, ['alex', 'Alex']);
      if (!alex?.visible) fail('040: Alex not visible');
      const headY = alex.landmarks?.headTop?.y;
      const shoulderY = alex.landmarks?.shoulders?.y;
      const waistIn = alex.landmarks?.waist?.inFrame === true;
      const feetIn = alex.landmarks?.feet?.inFrame === true;
      if (headY === undefined) fail('040: missing headTop landmark');
      if (shoulderY === undefined) fail('040: missing shoulders landmark');
      if (headY < 0.03 || headY > 0.22) {
        fail(`040: headroom headTopY ${headY.toFixed(3)} outside close-up band`);
      }
      if (shoulderY < 0.70 || shoulderY > 1.10) {
        fail(`040: shoulders Y ${shoulderY.toFixed(3)} not near frame bottom`);
      }
      if (waistIn && (alex.landmarks?.waist?.y ?? 1) < 0.98) {
        fail('040: waist still in frame for close-up');
      }
      if (feetIn && (alex.landmarks?.feet?.y ?? 1) < 0.98) {
        fail('040: legs/feet still in frame for close-up');
      }
      break;
    }
    default:
      break;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
