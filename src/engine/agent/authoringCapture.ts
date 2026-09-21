import * as THREE from 'three';
import type { LocationProject, SceneObject } from '../../domain/types';
import { selectionBounds } from '../buildSelection';
import { buildScene, disposeScene } from '../sceneObjects';
import { resolveSceneRelationships } from '../sceneRelationships';

export type AgentAuthoringView =
  | 'isometric'
  | 'top'
  | 'front'
  | 'back'
  | 'left'
  | 'right';

export interface AgentAuthoringCaptureInput {
  view?: AgentAuthoringView;
  width?: number;
  height?: number;
  levelId?: string;
  padding?: number;
}

export interface AgentAuthoringCaptureResult {
  ok: boolean;
  view: AgentAuthoringView;
  width: number;
  height: number;
  mimeType: 'image/png';
  dataUrl: string;
  levelId?: string;
  visibleObjectIds: string[];
}

function architectureLevelId(object: SceneObject): string | undefined {
  const architecture = object.metadata?.architecture;
  if (!architecture || typeof architecture !== 'object' || Array.isArray(architecture)) return undefined;
  const levelId = (architecture as Record<string, unknown>).levelId;
  return typeof levelId === 'string' ? levelId : undefined;
}

function clampDimension(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(128, Math.min(maximum, Math.floor(value!)));
}

function filteredProject(project: LocationProject, levelId?: string): {
  project: LocationProject;
  objects: SceneObject[];
} {
  const baseObjects = project.scene.objects.filter((object) => (
    object.visible !== false
    && object.type !== 'sun_marker'
    && (!levelId || architectureLevelId(object) === levelId)
  ));
  if (!levelId) return { project, objects: baseObjects };

  // Keep semantic cutter sources that affect a selected level even when the
  // source itself is not tagged to that level (stairs commonly span levels).
  const selectedIds = new Set(baseObjects.map((object) => object.id));
  const resolution = resolveSceneRelationships(project);
  const cutterSourceIds = new Set(
    resolution.relationships
      .filter((relationship) => (
        relationship.status === 'resolved'
        && relationship.targetId
        && selectedIds.has(relationship.targetId)
      ))
      .map((relationship) => relationship.sourceId),
  );
  const objects = project.scene.objects.filter((object) => (
    baseObjects.includes(object) || cutterSourceIds.has(object.id)
  ));
  return {
    project: {
      ...project,
      scene: {
        ...project.scene,
        objects,
      },
    },
    objects,
  };
}

function boundsOrFallback(objects: SceneObject[]): THREE.Box3 {
  const box = selectionBounds(objects);
  if (!box.isEmpty()) return box;
  return new THREE.Box3(
    new THREE.Vector3(-5, 0, -5),
    new THREE.Vector3(5, 3, 5),
  );
}

function configureOrthographicCamera(
  view: Exclude<AgentAuthoringView, 'isometric'>,
  bounds: THREE.Box3,
  width: number,
  height: number,
  padding: number,
): THREE.OrthographicCamera {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const aspect = width / height;

  let horizontal = size.x;
  let vertical = size.y;
  if (view === 'top') {
    horizontal = size.x;
    vertical = size.z;
  } else if (view === 'left' || view === 'right') {
    horizontal = size.z;
    vertical = size.y;
  }

  horizontal = Math.max(horizontal * padding, 2);
  vertical = Math.max(vertical * padding, 2);
  if (horizontal / vertical > aspect) vertical = horizontal / aspect;
  else horizontal = vertical * aspect;

  const camera = new THREE.OrthographicCamera(
    -horizontal / 2,
    horizontal / 2,
    vertical / 2,
    -vertical / 2,
    0.01,
    Math.max(1000, size.length() * 8),
  );

  const distance = Math.max(size.length() * 2, 20);
  if (view === 'top') {
    camera.position.set(center.x, center.y + distance, center.z);
    camera.up.set(0, 0, -1);
  } else if (view === 'front') {
    camera.position.set(center.x, center.y, center.z - distance);
    camera.up.set(0, 1, 0);
  } else if (view === 'back') {
    camera.position.set(center.x, center.y, center.z + distance);
    camera.up.set(0, 1, 0);
  } else if (view === 'right') {
    camera.position.set(center.x + distance, center.y, center.z);
    camera.up.set(0, 1, 0);
  } else {
    camera.position.set(center.x - distance, center.y, center.z);
    camera.up.set(0, 1, 0);
  }
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return camera;
}

function configureIsometricCamera(
  bounds: THREE.Box3,
  width: number,
  height: number,
  padding: number,
): THREE.PerspectiveCamera {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 2);
  const fov = 38;
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.01, Math.max(1000, radius * 12));
  const distance = (radius * padding) / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const direction = new THREE.Vector3(1, 0.85, -1).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return camera;
}

export async function captureAgentAuthoringView(
  project: LocationProject,
  input: AgentAuthoringCaptureInput = {},
): Promise<AgentAuthoringCaptureResult> {
  const view = input.view ?? 'isometric';
  const width = clampDimension(input.width, 768, 1280);
  const height = clampDimension(input.height, 512, 1024);
  const padding = Number.isFinite(input.padding)
    ? Math.max(1.02, Math.min(3, input.padding!))
    : 1.25;

  const filtered = filteredProject(project, input.levelId);
  const bounds = boundsOrFallback(filtered.objects);
  const scene = buildScene(filtered.project, {
    showHelpers: false,
    hiddenObjectTypes: ['sun_marker'],
  });
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
    alpha: false,
  });

  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(new THREE.Color(0xd8dde5), 1);

    const camera = view === 'isometric'
      ? configureIsometricCamera(bounds, width, height, padding)
      : configureOrthographicCamera(view, bounds, width, height, padding);

    renderer.render(scene, camera);
    return {
      ok: true,
      view,
      width,
      height,
      mimeType: 'image/png',
      dataUrl: renderer.domElement.toDataURL('image/png'),
      ...(input.levelId ? { levelId: input.levelId } : {}),
      visibleObjectIds: filtered.objects.map((object) => object.id),
    };
  } finally {
    disposeScene(scene);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
