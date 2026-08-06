/**
 * Bundled sample productions for the first-project launcher.
 * Samples are self-contained LocationProject documents with no external asset deps.
 * Visual assets: run `npm run sample:generate` (factory is canonical; JSON is a snapshot).
 */

import type {
  LocationProject,
  ProjectAsset,
  SceneObject,
  Shot,
  Vec3,
} from '../domain/types';
import {
  createCameraData,
  createDefaultExportConfiguration,
  createLandmark,
  createPanoAsset,
  createPanoReference,
  createSceneObject,
  createShot,
  DEFAULT_CAMERA_HEIGHT_METERS,
  defaultProjectSettings,
  defaultProjectWorkflow,
  defaultShotExportSettings,
  normalizeShotExportSettings,
} from '../domain/defaults';
import { createId } from '../utils/ids';
import { DIALOGUE_DEMO_ASSETS } from '../samples/dialogueDemoAssets';

/** Stable sample id used by the launcher, reset, and help catalog. */
export const DIALOGUE_DEMO_SAMPLE_ID = 'dialogue-demo';

export interface SampleProjectDefinition {
  id: string;
  title: string;
  summary: string;
  /** What the user obtains when they open this sample. */
  outcome: string;
  /** Factory always returns a fresh project (new ids / timestamps). */
  create: () => LocationProject;
}

function objectAt(
  type: SceneObject['type'],
  index: number,
  name: string,
  position: Vec3,
  extras: Partial<SceneObject> = {},
): SceneObject {
  const object = createSceneObject(type, index, position);
  object.name = name;
  // createSceneObject overwrites wall / human_dummy / sun_marker positions — re-apply.
  object.transform.position = [...position] as Vec3;
  Object.assign(object, extras);
  if (extras.transform?.position) {
    object.transform.position = [...extras.transform.position] as Vec3;
  }
  return object;
}

function makeImageAsset(params: {
  name: string;
  dataUri: string;
  width: number;
  height: number;
  role: string;
  extraMeta?: Record<string, unknown>;
}): ProjectAsset {
  const asset = createPanoAsset({
    name: params.name,
    uri: params.dataUri,
    width: params.width,
    height: params.height,
    metadata: {
      sample: true,
      sampleProjectId: DIALOGUE_DEMO_SAMPLE_ID,
      role: params.role,
      ...params.extraMeta,
    },
  });
  return {
    ...asset,
    type: 'image',
    mimeType: 'image/png',
  };
}

/**
 * Build the Dialogue Demo sample: one interior room, two characters, a table
 * prop, four production shots, graybox + styled panoramas, contact sheet,
 * per-shot viewport thumbnails, and complete export configuration.
 */
export function createDialogueDemoSample(): LocationProject {
  const now = new Date().toISOString();
  const settings = { ...defaultProjectSettings };
  const exportConfiguration = createDefaultExportConfiguration(
    normalizeShotExportSettings({
      ...defaultShotExportSettings,
      // Fast Control for AI-generation: projected motion only.
      includeCameraMoveVideo: false,
      includeProjectedCameraMoveVideo: true,
    }),
    'ai-generation',
  );
  exportConfiguration.videoPerformance = { profileId: 'fast-control' };

  const floor = objectAt('floor', 1, 'Room Floor', [0, -0.04, 0], {
    locked: true,
    dimensions: [8, 0.08, 7],
    stagingRole: 'set',
  });
  const backWall = objectAt('wall', 1, 'Back Wall', [0, 1.5, -3.4], {
    dimensions: [7.7, 3, 0.18],
    stagingRole: 'set',
  });
  const leftWall = objectAt('wall', 2, 'Left Wall', [-3.9, 1.5, 0], {
    dimensions: [6.7, 3, 0.18],
    stagingRole: 'set',
  });
  leftWall.transform.rotation = [0, 90, 0];
  const rightWall = objectAt('wall', 3, 'Right Wall', [3.9, 1.5, 0], {
    dimensions: [6.7, 3, 0.18],
    stagingRole: 'set',
  });
  rightWall.transform.rotation = [0, -90, 0];
  const doorway = objectAt('doorway', 1, 'Doorway', [0, 1.2, 3.35], {
    dimensions: [1.8, 2.4, 0.22],
    stagingRole: 'set',
  });

  const table = objectAt('box', 1, 'Table', [0, 0.4, 0], {
    dimensions: [1.2, 0.8, 0.7],
    stagingRole: 'prop',
    color: '#78716c',
    surfaceStyle: 'solid',
    metadata: { samplePropId: 'table' },
  });

  const alex = objectAt('human_dummy', 1, 'Alex', [-1.1, 0.875, 0.15], {
    dimensions: [0.55, 1.75, 0.55],
    stagingRole: 'person',
    color: '#60a5fa',
    surfaceStyle: 'solid',
    metadata: { sampleCastId: 'alex', height: 1.75 },
  });
  alex.transform.rotation = [0, 25, 0];

  const blair = objectAt('human_dummy', 2, 'Blair', [1.1, 0.84, 0.15], {
    dimensions: [0.55, 1.68, 0.55],
    stagingRole: 'person',
    color: '#f472b6',
    surfaceStyle: 'solid',
    metadata: { sampleCastId: 'blair', height: 1.68 },
  });
  blair.transform.rotation = [0, -25, 0];

  const sun = objectAt('sun_marker', 1, 'Key Light', [3.5, 4.5, -2.5]);

  const objects = [floor, backWall, leftWall, rightWall, doorway, table, alex, blair, sun];

  const grayboxPanoAsset = makeImageAsset({
    name: 'Dialogue Room Graybox Pano',
    dataUri: DIALOGUE_DEMO_ASSETS.grayboxPano.dataUri,
    width: DIALOGUE_DEMO_ASSETS.grayboxPano.width,
    height: DIALOGUE_DEMO_ASSETS.grayboxPano.height,
    role: 'graybox-panorama',
  });

  const styledPanoAsset = makeImageAsset({
    name: 'Dialogue Room Styled Pano',
    dataUri: DIALOGUE_DEMO_ASSETS.styledPano.dataUri,
    width: DIALOGUE_DEMO_ASSETS.styledPano.width,
    height: DIALOGUE_DEMO_ASSETS.styledPano.height,
    role: 'styled-panorama',
  });

  // Contact sheet doubles as the sample marker (retainInProject survives prune).
  const contactSheet = makeImageAsset({
    name: 'Dialogue Demo Contact Sheet',
    dataUri: DIALOGUE_DEMO_ASSETS.contactSheet.dataUri,
    width: DIALOGUE_DEMO_ASSETS.contactSheet.width,
    height: DIALOGUE_DEMO_ASSETS.contactSheet.height,
    role: 'contact-sheet',
    extraMeta: {
      retainInProject: true,
      sampleVersion: 1,
    },
  });

  const shotThumbAssets: Record<string, ProjectAsset> = {};
  for (const [shotNumber, thumb] of Object.entries(DIALOGUE_DEMO_ASSETS.shotThumbnails)) {
    shotThumbAssets[shotNumber] = makeImageAsset({
      name: `Shot ${shotNumber} Thumbnail`,
      dataUri: thumb.dataUri,
      width: thumb.width,
      height: thumb.height,
      role: 'shot-thumbnail',
      extraMeta: { shotNumber },
    });
  }

  const grayboxPano = createPanoReference({
    name: 'Room Graybox Capture',
    assetId: grayboxPanoAsset.id,
    type: 'graybox_render',
    origin: [0, DEFAULT_CAMERA_HEIGHT_METERS, 0],
    rotation: [0, 0, 0],
    width: grayboxPanoAsset.width ?? 1024,
    height: grayboxPanoAsset.height ?? 512,
    isCanonical: false,
    notes: 'Bundled sample graybox panorama of the dialogue room.',
  });

  const styledPano = createPanoReference({
    name: 'Room Style Reference',
    assetId: styledPanoAsset.id,
    type: 'ai_global_reference',
    origin: [0, DEFAULT_CAMERA_HEIGHT_METERS, 0],
    rotation: [0, 0, 0],
    width: styledPanoAsset.width ?? 1024,
    height: styledPanoAsset.height ?? 512,
    isCanonical: true,
    sourcePanoId: grayboxPano.id,
    notes: 'Bundled sample styled panorama of the same room — projection target for Reference.',
  });

  const scene = {
    worldUp: 'Y' as const,
    objects,
    panoOrigin: [0, DEFAULT_CAMERA_HEIGHT_METERS, 0] as Vec3,
    panoRotation: [0, 0, 0] as Vec3,
  };

  const shotExport = normalizeShotExportSettings(exportConfiguration.defaults);

  const wideCamera = createCameraData([0, 1.55, 4.2], [0, 1.35, 0], 55);
  wideCamera.aspectRatio = 16 / 9;
  const mediumCamera = createCameraData([-0.35, 1.5, 2.6], [-1.05, 1.45, 0.15], 40);
  mediumCamera.aspectRatio = 16 / 9;
  const otsCamera = createCameraData([0.85, 1.52, 1.35], [-1.0, 1.5, 0.1], 38);
  otsCamera.aspectRatio = 16 / 9;
  const cuCamera = createCameraData([-0.55, 1.55, 1.55], [-1.1, 1.55, 0.15], 28);
  cuCamera.aspectRatio = 16 / 9;

  const makeShot = (
    index: number,
    shotNumber: string,
    name: string,
    description: string,
    camera: ReturnType<typeof createCameraData>,
    overrides: NonNullable<Shot['objectOverrides']>,
  ): Shot => {
    const shot = createShot({
      index,
      camera,
      linkedPanoId: styledPano.id,
      exportDefaults: shotExport,
    });
    shot.shotNumber = shotNumber;
    shot.name = name;
    shot.description = description;
    // Deep-clone so per-shot staging never shares object identity.
    shot.objectOverrides = structuredClone(overrides);
    shot.status = 'planned';
    shot.exportSettings = { ...shotExport };
    shot.exportOverrides = {};
    const thumb = shotThumbAssets[shotNumber];
    if (thumb) {
      shot.assets = {
        ...shot.assets,
        viewportRenderAssetId: thumb.id,
      };
    }
    shot.metadata = {
      sampleProjectId: DIALOGUE_DEMO_SAMPLE_ID,
    };
    return shot;
  };

  const dialogueStaging: NonNullable<Shot['objectOverrides']> = {
    [alex.id]: {
      transform: { ...alex.transform, position: [...alex.transform.position] as Vec3 },
      visible: true,
    },
    [blair.id]: {
      transform: { ...blair.transform, position: [...blair.transform.position] as Vec3 },
      visible: true,
    },
    [table.id]: {
      transform: { ...table.transform, position: [...table.transform.position] as Vec3 },
      visible: true,
    },
  };

  const alexSoloStaging: NonNullable<Shot['objectOverrides']> = {
    [alex.id]: {
      transform: { ...alex.transform, position: [...alex.transform.position] as Vec3 },
      visible: true,
    },
    [blair.id]: {
      transform: { ...blair.transform, position: [...blair.transform.position] as Vec3 },
      visible: false,
    },
    [table.id]: {
      transform: { ...table.transform, position: [...table.transform.position] as Vec3 },
      visible: true,
    },
  };

  const shots: Shot[] = [
    makeShot(
      1,
      '010',
      'Wide two-shot',
      'Alex and Blair standing across from each other in the dialogue room.',
      wideCamera,
      dialogueStaging,
    ),
    makeShot(
      2,
      '020',
      'Alex medium',
      'Medium on Alex listening.',
      mediumCamera,
      dialogueStaging,
    ),
    makeShot(
      3,
      '030',
      'Blair OTS',
      "Over Blair's shoulder onto Alex.",
      otsCamera,
      dialogueStaging,
    ),
    makeShot(
      4,
      '040',
      'Alex close-up',
      'Close-up reaction on Alex.',
      cuCamera,
      alexSoloStaging,
    ),
  ];

  const center = createLandmark(1, [0, 1.2, 0]);
  center.name = 'room_center';
  center.displayName = 'Room Center';
  center.description = 'Center of the dialogue room stage.';

  const registryAssets: Record<string, ProjectAsset> = {
    [grayboxPanoAsset.id]: grayboxPanoAsset,
    [styledPanoAsset.id]: styledPanoAsset,
    [contactSheet.id]: contactSheet,
  };
  for (const thumb of Object.values(shotThumbAssets)) {
    registryAssets[thumb.id] = thumb;
  }

  const project: LocationProject = {
    schemaVersion: '1.0',
    productVersion: '0.1.0',
    id: createId('project'),
    name: 'Dialogue Demo',
    description:
      'Bundled ForeScene sample: one interior room, graybox + styled panoramas, two characters, table prop, four shots (wide two-shot, medium, OTS, close-up), contact sheet, and export settings. Safe to experiment — use Reset sample to restore the baseline.',
    units: 'meters',
    createdAt: now,
    updatedAt: now,
    scene,
    panoRefs: [grayboxPano, styledPano],
    landmarks: [center],
    shots,
    assets: { assets: registryAssets },
    settings: {
      ...settings,
      projectedStyle: {
        ...settings.projectedStyle,
        panoId: styledPano.id,
        blendMode: 'primary_only',
        opacity: 1,
        fallbackMode: 'clay',
      },
    },
    workflow: {
      ...defaultProjectWorkflow,
      grayboxApprovedForReferenceAt: now,
      referenceAlignmentAcceptedForPanoId: styledPano.id,
      shotFramingAcceptedAtByShotId: Object.fromEntries(
        shots.map((shot) => [shot.id, now]),
      ),
    },
    exportConfiguration,
  };

  return project;
}

export const SAMPLE_PROJECTS: readonly SampleProjectDefinition[] = [
  {
    id: DIALOGUE_DEMO_SAMPLE_ID,
    title: 'Dialogue Demo',
    summary: 'Two-character interior dialogue with four classic coverage shots.',
    outcome:
      'A complete mini production: room set, graybox + styled panoramas, Alex & Blair, table prop, wide / medium / OTS / close-up shots with thumbnails, and export settings ready to open.',
    create: createDialogueDemoSample,
  },
];

export function getSampleProjectDefinition(sampleId: string): SampleProjectDefinition | undefined {
  return SAMPLE_PROJECTS.find((sample) => sample.id === sampleId);
}

/** Load a fresh copy of a bundled sample (always from the canonical factory). */
export function loadSampleProject(sampleId: string): LocationProject {
  const definition = getSampleProjectDefinition(sampleId);
  if (!definition) {
    throw new Error(`Unknown sample project: ${sampleId}`);
  }
  return definition.create();
}

/**
 * Reset a sample by reloading the canonical factory.
 * Always returns a new project document; callers replace the live project.
 */
export function resetSampleProject(sampleId: string): LocationProject {
  return loadSampleProject(sampleId);
}

/**
 * True when the project carries the Dialogue Demo sample marker
 * (`metadata.sampleProjectId` on any asset). Survives rename and shot edits.
 */
export function isDialogueDemoSample(project: LocationProject): boolean {
  return getSampleProjectId(project) === DIALOGUE_DEMO_SAMPLE_ID;
}

/** Resolve the stable sample id from asset markers, if present. */
export function getSampleProjectId(project: LocationProject): string | undefined {
  for (const asset of Object.values(project.assets?.assets ?? {})) {
    const id = asset.metadata?.sampleProjectId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  for (const shot of project.shots ?? []) {
    const id = shot.metadata?.sampleProjectId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}
