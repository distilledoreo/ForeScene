/**
 * Build agentic-control seed packages from built-in graybox primitives.
 * No external GLB binaries.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCameraData,
  createDefaultExportConfiguration,
  createDefaultProject,
  createOriginShot,
  createSceneObject,
  createShot,
  defaultProjectSettings,
  defaultProjectWorkflow,
} from '../../src/domain/defaults';
import type { LocationProject } from '../../src/domain/types';
import { createProjectPackage } from '../../src/engine/projectIO';
import { createId } from '../../src/utils/ids';
import type { AgenticControlContractId } from './agenticControlContract';
import { repoRoot } from './layout';

const V1_SEED_NAME = 'lifecycle-temple.fsp';
const V2_SEED_NAME = 'operator-corridor.fsp';
const V3_SEED_NAME = 'import-empty.fsp';

function createOperatorCorridorProject(): LocationProject {
  const now = new Date().toISOString();
  const objects = [
    createSceneObject('floor', 1),
    createSceneObject('wall', 1),
    createSceneObject('wall', 2),
    createSceneObject('doorway', 1),
    createSceneObject('stairs', 1),
    createSceneObject('column', 1),
    createSceneObject('human_dummy', 1),
    createSceneObject('sun_marker', 1),
  ];

  objects[0].name = 'Corridor Floor';
  objects[0].locked = true;
  objects[0].dimensions = [10, 0.08, 18];
  objects[1].name = 'Left Corridor Wall';
  objects[1].dimensions = [0.18, 3, 16];
  objects[1].transform.position = [-4.9, 1.5, 0];
  objects[2].name = 'Right Corridor Wall';
  objects[2].dimensions = [0.18, 3, 16];
  objects[2].transform.position = [4.9, 1.5, 0];
  objects[3].name = 'North Doorway';
  objects[3].dimensions = [2.2, 2.6, 0.25];
  objects[3].transform.position = [0, 1.3, -7.8];
  objects[4].name = 'South Stairs';
  objects[4].dimensions = [3.2, 1.4, 2.8];
  objects[4].transform.position = [0, 0.7, 6.5];
  objects[5].name = 'Mid Corridor Column';
  objects[5].dimensions = [0.55, 2.8, 0.55];
  objects[5].transform.position = [1.8, 1.4, -1.5];
  objects[6].name = 'Blocking Figure';
  objects[6].transform.position = [-1.4, 0.875, 2.2];
  objects[7].name = 'Sun Marker';

  const settings = { ...defaultProjectSettings };
  const scene = {
    worldUp: 'Y' as const,
    objects,
    panoOrigin: [0, settings.defaultCameraHeightMeters, 0] as [number, number, number],
    panoRotation: [0, 0, 0] as [number, number, number],
  };
  const exportConfiguration = createDefaultExportConfiguration();
  const firstShot = createOriginShot({ scene, settings, exportConfiguration }, 1);
  firstShot.name = 'Corridor Wide';
  firstShot.description = 'Establishing view down the corridor toward the doorway.';

  const secondCamera = createCameraData(
    [2.4, settings.defaultCameraHeightMeters, 4.8],
    [0, settings.defaultCameraHeightMeters, -2],
    settings.defaultShotFovDegrees,
  );
  const secondShot = createShot({
    index: 2,
    camera: secondCamera,
    exportDefaults: exportConfiguration.defaults,
  });
  secondShot.name = 'Stair Landing';
  secondShot.description = 'Tighter angle on the stairs and blocking figure.';

  return {
    schemaVersion: '1.0',
    productVersion: '0.1.0',
    id: createId('project'),
    name: 'Operator Intent Seed',
    description: 'Built-in corridor graybox with two shots — operator-intent family B.',
    units: 'meters',
    createdAt: now,
    updatedAt: now,
    scene,
    panoRefs: [],
    landmarks: [],
    shots: [firstShot, secondShot],
    assets: { assets: {} },
    settings,
    workflow: { ...defaultProjectWorkflow },
    exportConfiguration,
  };
}

async function writeSeedPackage(project: LocationProject, target: string): Promise<string> {
  const blob = await createProjectPackage(project);
  const bytes = Buffer.from(await blob.arrayBuffer());
  await writeFile(target, bytes);
  return target;
}

export async function buildAgenticControlSeed(outputDir?: string): Promise<string> {
  const root = repoRoot();
  const targetDir = outputDir ?? path.join(root, 'benchmarks/agentic-control-v1/seed');
  await mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, V1_SEED_NAME);

  const project = createDefaultProject();
  project.name = 'Agentic Control Seed';
  project.description = 'Built-in temple graybox with one origin shot — lifecycle-control family A.';

  return writeSeedPackage(project, target);
}

export async function buildAgenticControlV2Seed(outputDir?: string): Promise<string> {
  const root = repoRoot();
  const targetDir = outputDir ?? path.join(root, 'benchmarks/agentic-control-v2/seed');
  await mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, V2_SEED_NAME);
  return writeSeedPackage(createOperatorCorridorProject(), target);
}

export async function buildAgenticControlV3Seed(outputDir?: string): Promise<string> {
  const root = repoRoot();
  const targetDir = outputDir ?? path.join(root, 'benchmarks/agentic-control-v3/seed');
  await mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, V3_SEED_NAME);

  const now = new Date().toISOString();
  const settings = { ...defaultProjectSettings };
  const scene = {
    worldUp: 'Y' as const,
    objects: [
      (() => {
        const floor = createSceneObject('floor', 1);
        floor.name = 'Import Empty Floor';
        floor.locked = true;
        floor.dimensions = [8, 0.08, 8];
        return floor;
      })(),
      (() => {
        const sun = createSceneObject('sun_marker', 1);
        sun.name = 'Sun Marker';
        return sun;
      })(),
    ],
    panoOrigin: [0, settings.defaultCameraHeightMeters, 0] as [number, number, number],
    panoRotation: [0, 0, 0] as [number, number, number],
  };
  const exportConfiguration = createDefaultExportConfiguration();
  const originShot = createOriginShot({ scene, settings, exportConfiguration }, 1);
  originShot.name = 'Import Empty Origin';
  originShot.description = 'Minimal seed for import-idempotency family C.';

  const project: LocationProject = {
    schemaVersion: '1.0',
    productVersion: '0.1.0',
    id: createId('project'),
    name: 'Import Idempotency Seed',
    description: 'Minimal graybox with one shot and no imported models — import-idempotency family C.',
    units: 'meters',
    createdAt: now,
    updatedAt: now,
    scene,
    panoRefs: [],
    landmarks: [],
    shots: [originShot],
    assets: { assets: {} },
    settings,
    workflow: { ...defaultProjectWorkflow },
    exportConfiguration,
  };

  return writeSeedPackage(project, target);
}

export async function buildAgenticControlSeedForContract(
  contractId: AgenticControlContractId,
  outputDir?: string,
): Promise<string> {
  if (contractId === 'agentic-control-v3') return buildAgenticControlV3Seed(outputDir);
  if (contractId === 'agentic-control-v4') return buildAgenticControlV2Seed(outputDir);
  if (contractId === 'agentic-control-v2') return buildAgenticControlV2Seed(outputDir);
  return buildAgenticControlSeed(outputDir);
}

async function main(): Promise<void> {
  const contractArg = process.argv.find((arg) => arg.startsWith('--contract='))?.split('=')[1]
    ?? (process.argv.includes('--v3') ? 'agentic-control-v3'
      : process.argv.includes('--v2') ? 'agentic-control-v2' : 'agentic-control-v1');
  const target = contractArg === 'agentic-control-v3'
    ? await buildAgenticControlV3Seed()
    : contractArg === 'agentic-control-v2'
      ? await buildAgenticControlV2Seed()
      : await buildAgenticControlSeed();
  const { stat } = await import('node:fs/promises');
  const info = await stat(target);
  process.stdout.write(`Wrote ${target} (${info.size} bytes)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
