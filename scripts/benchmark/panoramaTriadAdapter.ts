import path from 'node:path';
import type { PrevisProductionManifestV1, PrevisShotDefinition } from '../../src/engine/previs/manifest';
import type { BenchmarkShotSpec, BenchmarkSpecV1 } from './types';

interface FrozenAsset {
  file: string;
  rigFile?: string;
  importAs: string;
}

interface FrozenShot {
  shotNumber: string;
  name: string;
  kind: string;
  location: string;
  linkedPanoId: string | null;
  assets: FrozenAsset[];
  requirements: string[];
  deliverable?: string;
  deliverables?: string[];
}

interface FrozenPanoramaTriadSpec {
  benchmarkId: 'music-video-v2-panorama-triad';
  version: string;
  mode: string;
  baseProject: {
    expectedShotCount: number;
    expectedSceneObjectCount: number;
    expectedPanoRefCount: number;
    expectedLandmarkCount: number;
  };
  locations: Record<string, { anchorLandmark: string; styledPanoId: string | null; note?: string }>;
  shots: FrozenShot[];
  standardDeliverables: string[];
}

export function isFrozenPanoramaTriadSpec(value: unknown): value is FrozenPanoramaTriadSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<FrozenPanoramaTriadSpec>;
  return record.benchmarkId === 'music-video-v2-panorama-triad'
    && typeof record.version === 'string'
    && Array.isArray(record.shots)
    && Boolean(record.locations)
    && Array.isArray(record.standardDeliverables);
}

function requiredSubjects(shotNumber: string): string[] {
  if (shotNumber === '01') return ['hand-monster'];
  if (shotNumber === '02') return ['joseph-amputated', 'hand-monster'];
  if (shotNumber === '03') return ['joseph-final', 'shield', 'wrist-blade'];
  throw new Error(`Unsupported panorama-triad shot number: ${shotNumber}`);
}

function artifacts(shot: FrozenShot): string[] {
  const result = shot.deliverables ?? (shot.deliverable ? [shot.deliverable] : []);
  if (result.length === 0) throw new Error(`Panorama-triad shot ${shot.shotNumber} has no deliverables.`);
  return result;
}

function assetContract(shot: FrozenShot): string {
  return shot.assets.map((asset) => (
    `${asset.file} as ${asset.importAs}${asset.rigFile ? ` with ${asset.rigFile}` : ''}`
  )).join('; ');
}

function shotDescription(shot: FrozenShot): string {
  return [
    ...shot.requirements,
    `Asset contract: ${assetContract(shot)}.`,
    `Panorama linkage: ${shot.linkedPanoId ?? 'none'}.`,
    `Required outputs: ${artifacts(shot).join(', ')}.`,
  ].join(' ');
}

function benchmarkShot(shot: FrozenShot): BenchmarkShotSpec {
  const deliverables = artifacts(shot);
  const motion = shot.kind === 'three_second_motion';
  return {
    id: `mv3-shot-${shot.shotNumber}`,
    shotNumber: shot.shotNumber,
    name: shot.name,
    description: shotDescription(shot),
    intent: motion ? 'motion-required' : 'still',
    requiredSubjects: requiredSubjects(shot.shotNumber),
    framing: shot.shotNumber === '01' ? 'close_up' : 'full',
    stillArtifacts: deliverables.filter((item) => item.toLowerCase().endsWith('.png')),
    ...(motion ? { motionArtifacts: deliverables.filter((item) => item.toLowerCase().endsWith('.mp4')) } : {}),
  };
}

function productionShot(shot: FrozenShot): PrevisShotDefinition {
  const subjects = requiredSubjects(shot.shotNumber);
  const visibleSubjects = subjects.filter((id) => id.startsWith('joseph-'));
  const visibleProps = subjects.filter((id) => id === 'shield' || id === 'wrist-blade');
  const chaseMotion: PrevisShotDefinition['motion'] = shot.shotNumber === '02'
    ? {
        durationSeconds: 3,
        renderControlVideo: true,
        keyframes: [
          {
            timeSeconds: 0,
            camera: { position: [95.5, 1.8, -5.3], target: [100, 1, -5.9], fovDegrees: 35 },
            staging: [
              { subject: 'joseph-amputated', transform: { position: [100, 0.875, -5.3] } },
              { subject: 'hand-monster', transform: { position: [100, 0, -6.5] } },
            ],
          },
          {
            timeSeconds: 1.5,
            camera: { position: [95.5, 1.8, 0], target: [100, 1, -0.6], fovDegrees: 35 },
            staging: [
              { subject: 'joseph-amputated', transform: { position: [100, 0.875, 0] } },
              { subject: 'hand-monster', transform: { position: [100, 0, -1.2] } },
            ],
          },
          {
            timeSeconds: 3,
            camera: { position: [95.5, 1.8, 5.3], target: [100, 1, 4.7], fovDegrees: 35 },
            staging: [
              { subject: 'joseph-amputated', transform: { position: [100, 0.875, 5.3] } },
              { subject: 'hand-monster', transform: { position: [100, 0, 4.1] } },
            ],
          },
        ],
      }
    : undefined;
  return {
    id: `mv3-shot-${shot.shotNumber}`,
    shotNumber: shot.shotNumber,
    name: shot.name,
    description: shotDescription(shot),
    locationId: shot.location,
    subjects,
    blocking: subjects.map((subject, index) => ({
      subject,
      placement: index === 0
        ? { type: 'location_slot' as const, slot: shot.shotNumber === '02' ? 'background' as const : 'center' as const }
        : { type: 'relative' as const, anchor: subjects[0]!, relation: 'behind' as const },
    })),
    camera: {
      template: shot.shotNumber === '01' ? 'close_up' : 'full',
      subjects: subjects.filter((id) => id !== 'shield' && id !== 'wrist-blade'),
      angle: shot.shotNumber === '02' ? 'three_quarter' : 'front',
      lensClass: shot.shotNumber === '01' ? 'wide' : 'normal',
    },
    requirements: {
      ...(visibleSubjects.length > 0 ? { visibleSubjects } : {}),
      ...(visibleProps.length > 0 ? { visibleProps } : {}),
      notes: [
        ...shot.requirements,
        `Use panorama ${shot.linkedPanoId ?? 'none'} for this shot.`,
        `Use ${assetContract(shot)}.`,
        `Produce ${artifacts(shot).join(', ')}.`,
      ],
    },
    ...(chaseMotion ? { motion: chaseMotion } : {}),
  };
}

export function adaptFrozenPanoramaTriadSpec(
  source: FrozenPanoramaTriadSpec,
  specPath: string,
): BenchmarkSpecV1 {
  const benchmarkRoot = path.dirname(path.resolve(specPath));
  const shotNumbers = source.shots.map((shot) => shot.shotNumber);
  if (shotNumbers.join(',') !== '01,02,03') {
    throw new Error(`Frozen panorama-triad must contain exact shots 01, 02, 03; received ${shotNumbers.join(', ')}.`);
  }
  if (source.baseProject.expectedShotCount !== 0) {
    throw new Error('Frozen panorama-triad requires a neutral zero-shot base project.');
  }

  const asset = (name: string) => path.join(benchmarkRoot, 'assets', name);
  const productionManifest: PrevisProductionManifestV1 = {
    version: 2,
    project: {
      name: source.benchmarkId,
      operatingMode: 'existing-project-refinement',
      description: `Frozen benchmark ${source.version}. Repair budget: 2 autonomous repair rounds. Preserve the imported environment-only base.`,
      aspectRatio: '16:9',
      frameRate: 24,
    },
    locations: Object.entries(source.locations).map(([id, location]) => ({
      id,
      name: id === 'ruins' ? 'Roman ruins' : id === 'corridor' ? 'Roman ruins corridor' : 'Armory',
      description: [
        `Use the existing environment at landmark ${location.anchorLandmark}.`,
        `Styled panorama: ${location.styledPanoId ?? 'none'}.`,
        ...(location.note ? [location.note] : []),
      ].join(' '),
      template: id === 'corridor' ? 'corridor' : id === 'armory' ? 'armory' : 'ruins',
    })),
    cast: [
      {
        id: 'joseph-amputated',
        name: 'Joseph J2 Amputated',
        type: 'imported_character',
        source: asset('Roman Joseph Amputated.glb'),
        rigMode: 'saved-rig',
        rigPackage: asset('Roman Joseph Amputated.fsrig'),
      },
      {
        id: 'joseph-final',
        name: 'Joseph J3 Final',
        type: 'imported_character',
        source: asset('Roman Joseph Final.glb'),
        rigMode: 'saved-rig',
        rigPackage: asset('Roman Joseph Final.fsrig'),
      },
    ],
    assets: [{
      id: 'hand-monster',
      type: 'imported_model',
      source: asset('Hand_Monster_v3.glb'),
      importMode: 'ordinary_model',
      semanticRole: 'subject',
      required: true,
    }],
    props: [
      { id: 'shield', name: 'Left-arm shield', primitive: 'shield' },
      { id: 'wrist-blade', name: 'Right wrist-mounted short sword prosthetic', primitive: 'sword' },
    ],
    shots: source.shots.map(productionShot),
  };

  return {
    version: 1,
    id: source.benchmarkId,
    name: 'ForeScene music-video panorama-triad',
    description: `Frozen ${source.benchmarkId} ${source.version}; adapted mechanically by Benchmark V3.`,
    qualityMode: 'production-integrity',
    operatingMode: 'existing-project-refinement',
    writeAuthorized: true,
    resetAuthorized: false,
    repairBudget: 2,
    semanticSubjectBindings: [
      { semanticId: 'hand-monster', name: 'Hand Monster', stagingRole: 'subject' },
      { semanticId: 'joseph-amputated', name: 'Joseph J2 Amputated', stagingRole: 'character' },
      { semanticId: 'joseph-final', name: 'Joseph J3 Final', stagingRole: 'character' },
    ],
    requiredCliCapabilities: [
      'project.inspect',
      'project.open',
      'project.save',
      'project.applyPlan',
      'render.frame.clay',
      'render.frame.projected',
      'render.video.clay',
      'character.importSavedRig',
      'model.import',
      'shot.panorama',
    ],
    basePackage: path.join(benchmarkRoot, 'seed', 'what_im_fighting_for_panorama_triad_base.fsp'),
    requiredArtifacts: [...source.standardDeliverables],
    shots: source.shots.map(benchmarkShot),
    productionManifest,
  };
}
