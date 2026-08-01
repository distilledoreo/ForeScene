/**
 * Bundled sample productions for the first-project launcher.
 * Samples are self-contained LocationProject documents with no external asset deps.
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

/** Stable sample id used by the launcher and help catalog. */
export const DIALOGUE_DEMO_SAMPLE_ID = 'dialogue-demo';

/**
 * Tiny solid-color PNG (4×2) used as a stand-in equirect / contact-sheet asset.
 * No network or filesystem dependency.
 */
export const SAMPLE_INLINE_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGNIWPoLjhiQOQDK4g/5aoZNPAAAAABJRU5ErkJggg==';

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

/**
 * Build the Dialogue Demo sample: one interior room, two characters, a table
 * prop, four production shots, a styled panorama reference (inline PNG),
 * complete export configuration, and a pre-generated contact-sheet asset.
 */
export function createDialogueDemoSample(): LocationProject {
  const now = new Date().toISOString();
  const settings = { ...defaultProjectSettings };
  // Full AI-generation defaults; graybox + styled panos are both bundled below
  // so Export preflight has no missing-graybox / missing-projector gaps.
  const exportConfiguration = createDefaultExportConfiguration(
    normalizeShotExportSettings({ ...defaultShotExportSettings }),
  );
  exportConfiguration.activeProfileId = 'ai-generation';

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

  const styledPanoAsset = createPanoAsset({
    name: 'Dialogue Room Styled Pano',
    uri: SAMPLE_INLINE_PNG_DATA_URI,
    width: 4,
    height: 2,
    metadata: {
      sample: true,
      role: 'styled-panorama',
      note: 'Inline placeholder equirectangular — no external file dependency.',
    },
  });

  const grayboxPanoAsset = createPanoAsset({
    name: 'Dialogue Room Graybox Pano',
    uri: SAMPLE_INLINE_PNG_DATA_URI,
    width: 4,
    height: 2,
    metadata: {
      sample: true,
      role: 'graybox-panorama',
      note: 'Inline placeholder graybox equirectangular for sample Export readiness.',
    },
  });

  const contactSheetAsset = createPanoAsset({
    name: 'Dialogue Demo Contact Sheet',
    uri: SAMPLE_INLINE_PNG_DATA_URI,
    width: 4,
    height: 2,
    metadata: {
      sample: true,
      role: 'contact-sheet',
      note: 'Pre-generated contact-sheet stand-in for the sample production.',
    },
  });

  // Contact sheet is not a pano; force type metadata while reusing helper shape.
  const contactSheet: ProjectAsset = {
    ...contactSheetAsset,
    type: 'image',
    mimeType: 'image/png',
  };

  const grayboxPano = createPanoReference({
    name: 'Room Graybox Capture',
    assetId: grayboxPanoAsset.id,
    type: 'graybox_render',
    origin: [0, DEFAULT_CAMERA_HEIGHT_METERS, 0],
    rotation: [0, 0, 0],
    width: 4,
    height: 2,
    isCanonical: false,
    notes: 'Bundled sample graybox panorama (inline PNG) so Export has no missing-graybox gaps.',
  });

  const styledPano = createPanoReference({
    name: 'Room Style Reference',
    assetId: styledPanoAsset.id,
    type: 'ai_global_reference',
    origin: [0, DEFAULT_CAMERA_HEIGHT_METERS, 0],
    rotation: [0, 0, 0],
    width: 4,
    height: 2,
    isCanonical: true,
    sourcePanoId: grayboxPano.id,
    notes: 'Bundled sample styled panorama (inline PNG). Align or replace in Reference when experimenting.',
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
    overrides: Shot['objectOverrides'],
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
    shot.objectOverrides = overrides;
    shot.status = 'planned';
    shot.exportSettings = { ...shotExport };
    shot.exportOverrides = {};
    return shot;
  };

  // Staging: keep both characters + table visible with dialogue blocking.
  const dialogueStaging: Shot['objectOverrides'] = {
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

  const alexSoloStaging: Shot['objectOverrides'] = {
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

  const project: LocationProject = {
    schemaVersion: '1.0',
    productVersion: '0.1.0',
    id: createId('project'),
    name: 'Dialogue Demo',
    description:
      'Bundled ForeScene sample: one interior room, styled panorama, two characters, table prop, and four shots (wide two-shot, medium, OTS, close-up). Safe to experiment — use Reset sample to restore the baseline.',
    units: 'meters',
    createdAt: now,
    updatedAt: now,
    scene,
    panoRefs: [grayboxPano, styledPano],
    landmarks: [center],
    shots,
    assets: {
      assets: {
        [styledPanoAsset.id]: styledPanoAsset,
        [grayboxPanoAsset.id]: grayboxPanoAsset,
        [contactSheet.id]: contactSheet,
      },
    },
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
      // Mark framing accepted so Export guidance is not blocked for the sample.
      shotFramingAcceptedAtByShotId: Object.fromEntries(
        shots.map((shot) => [shot.id, now]),
      ),
    },
    exportConfiguration,
  };

  // Tag for reset detection without changing schema.
  project.assets.assets[contactSheet.id] = {
    ...contactSheet,
    metadata: {
      ...contactSheet.metadata,
      sampleProjectId: DIALOGUE_DEMO_SAMPLE_ID,
    },
  };

  return project;
}

export const SAMPLE_PROJECTS: readonly SampleProjectDefinition[] = [
  {
    id: DIALOGUE_DEMO_SAMPLE_ID,
    title: 'Dialogue Demo',
    summary: 'Two-character interior dialogue with four classic coverage shots.',
    outcome:
      'A complete mini production: room set, styled panorama, Alex & Blair, table prop, wide / medium / OTS / close-up shots, and export settings ready to open.',
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

/** True when the project looks like the Dialogue Demo sample (for UI affordances). */
export function isDialogueDemoSample(project: LocationProject): boolean {
  if (project.name !== 'Dialogue Demo') return false;
  const shotNumbers = project.shots.map((shot) => shot.shotNumber).sort();
  if (shotNumbers.join(',') !== '010,020,030,040') return false;
  const people = project.scene.objects.filter((object) => object.stagingRole === 'person');
  if (people.length < 2) return false;
  return project.panoRefs.some((pano) => pano.type === 'ai_global_reference');
}
