import React, { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Euler, PanoViewState } from '../../domain/types';
import { panoYawToThreeJsYawDegrees } from '../../engine/sync';
import { useThemeStore } from '../../state/useThemeStore';

const THEME_COLORS = {
  light: { empty: 0xe4e7e5, background: 0xf4f6f4 },
  dark: { empty: 0x243040, background: 0x0f1419 },
} as const;

const MAX_INTERACTIVE_PIXEL_RATIO = 1.5;

export function PanoViewer({
  imageUrl,
  view,
  onViewChange,
  label,
  panoRotation = [0, 0, 0],
  compareImageUrl,
  compareRotation = [0, 0, 0],
  compareOpacity = 1,
}: {
  imageUrl?: string;
  view: PanoViewState;
  onViewChange: (updates: Partial<PanoViewState>) => void;
  label?: string;
  panoRotation?: Euler;
  compareImageUrl?: string;
  compareRotation?: Euler;
  compareOpacity?: number;
}) {
  const theme = useThemeStore((state) => state.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const activeSceneRef = useRef<THREE.Scene | null>(null);
  const compareSceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const activeSphereRef = useRef<THREE.Mesh | null>(null);
  const compareSphereRef = useRef<THREE.Mesh | null>(null);
  const frameRef = useRef<number>(0);
  const renderFrameRef = useRef<() => void>(() => {});
  const dragRef = useRef({ active: false, x: 0, y: 0 });

  const requestRender = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      renderFrameRef.current();
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_INTERACTIVE_PIXEL_RATIO));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(THEME_COLORS[theme].background, 1);
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const activeScene = new THREE.Scene();
    const compareScene = new THREE.Scene();
    activeSceneRef.current = activeScene;
    compareSceneRef.current = compareScene;

    const camera = new THREE.PerspectiveCamera(view.fovDegrees, container.clientWidth / container.clientHeight, 0.1, 1000);
    cameraRef.current = camera;

    const compareSphere = createSphere(new THREE.MeshBasicMaterial({ color: THEME_COLORS[theme].empty }));
    const activeSphere = createSphere(new THREE.MeshBasicMaterial({ color: THEME_COLORS[theme].empty }));
    compareScene.add(compareSphere);
    activeScene.add(activeSphere);
    compareSphereRef.current = compareSphere;
    activeSphereRef.current = activeSphere;

    const onResize = () => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      cameraRef.current.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      requestRender();
    };
    window.addEventListener('resize', onResize);

    renderFrameRef.current = () => {
      if (!cameraRef.current || !rendererRef.current || !activeSceneRef.current || !compareSceneRef.current) return;

      rendererRef.current.clear(true, true, true);
      const hasCompare = Boolean(compareImageUrlRef.current);

      if (hasCompare) {
        configureCamera(cameraRef.current, viewRef.current, compareRotationRef.current);
        rendererRef.current.render(compareSceneRef.current, cameraRef.current);
        rendererRef.current.clearDepth();
      }

      configureCamera(cameraRef.current, viewRef.current, activeRotationRef.current);
      rendererRef.current.render(activeSceneRef.current, cameraRef.current);
    };
    requestRender();

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      renderFrameRef.current = () => {};
      window.removeEventListener('resize', onResize);
      disposeMesh(compareSphere);
      disposeMesh(activeSphere);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [requestRender, theme]);

  const viewRef = useRef(view);
  const activeRotationRef = useRef(panoRotation);
  const compareRotationRef = useRef(compareRotation);
  const compareImageUrlRef = useRef(compareImageUrl);
  const opacityRef = useRef(compareOpacity);
  useEffect(() => {
    viewRef.current = view;
    requestRender();
  }, [requestRender, view]);
  useEffect(() => {
    activeRotationRef.current = panoRotation;
    requestRender();
  }, [panoRotation, requestRender]);
  useEffect(() => {
    compareRotationRef.current = compareRotation;
    requestRender();
  }, [compareRotation, requestRender]);
  useEffect(() => {
    compareImageUrlRef.current = compareImageUrl;
    requestRender();
  }, [compareImageUrl, requestRender]);
  useEffect(() => {
    opacityRef.current = clamp01(compareOpacity);
    updateLayerOpacity(activeSphereRef.current?.material, compareImageUrl ? opacityRef.current : 1, Boolean(compareImageUrl));
    requestRender();
  }, [compareImageUrl, compareOpacity, requestRender]);

  useEffect(() => {
    let cancelled = false;
    setPanoSphereMaterial({
      sphere: activeSphereRef.current,
      imageUrl,
      theme,
      opacity: compareImageUrl ? opacityRef.current : 1,
      transparent: Boolean(compareImageUrl),
      isCancelled: () => cancelled,
      onMaterialReady: requestRender,
    });
    return () => {
      cancelled = true;
    };
  }, [compareImageUrl, imageUrl, requestRender, theme]);

  useEffect(() => {
    let cancelled = false;
    setPanoSphereMaterial({
      sphere: compareSphereRef.current,
      imageUrl: compareImageUrl,
      theme,
      opacity: 1,
      transparent: false,
      isCancelled: () => cancelled,
      onMaterialReady: requestRender,
    });
    return () => {
      cancelled = true;
    };
  }, [compareImageUrl, requestRender, theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onPointerDown = (event: PointerEvent) => {
      dragRef.current = { active: true, x: event.clientX, y: event.clientY };
      container.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragRef.current.active) return;
      const dx = event.clientX - dragRef.current.x;
      const dy = event.clientY - dragRef.current.y;
      dragRef.current.x = event.clientX;
      dragRef.current.y = event.clientY;
      const factor = viewRef.current.fovDegrees / Math.max(1, container.clientHeight);
      onViewChange({
        yawDegrees: viewRef.current.yawDegrees - dx * factor,
        pitchDegrees: Math.max(-89, Math.min(89, viewRef.current.pitchDegrees - dy * factor)),
      });
      requestRender();
    };
    const onPointerUp = (event: PointerEvent) => {
      dragRef.current.active = false;
      container.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      onViewChange({ fovDegrees: Math.max(18, Math.min(120, viewRef.current.fovDegrees + event.deltaY * 0.04)) });
      requestRender();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) {
          return;
        }
      }
      const step = event.shiftKey ? 8 : 3;
      const fovStep = event.shiftKey ? 4 : 2;
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          onViewChange({ yawDegrees: viewRef.current.yawDegrees - step });
          requestRender();
          break;
        case 'ArrowRight':
          event.preventDefault();
          onViewChange({ yawDegrees: viewRef.current.yawDegrees + step });
          requestRender();
          break;
        case 'ArrowUp':
          event.preventDefault();
          onViewChange({
            pitchDegrees: Math.max(-89, Math.min(89, viewRef.current.pitchDegrees + step)),
          });
          requestRender();
          break;
        case 'ArrowDown':
          event.preventDefault();
          onViewChange({
            pitchDegrees: Math.max(-89, Math.min(89, viewRef.current.pitchDegrees - step)),
          });
          requestRender();
          break;
        case '+':
        case '=':
          event.preventDefault();
          onViewChange({
            fovDegrees: Math.max(18, Math.min(120, viewRef.current.fovDegrees - fovStep)),
          });
          requestRender();
          break;
        case '-':
        case '_':
          event.preventDefault();
          onViewChange({
            fovDegrees: Math.max(18, Math.min(120, viewRef.current.fovDegrees + fovStep)),
          });
          requestRender();
          break;
        default:
          break;
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [onViewChange, requestRender]);

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-surface-base outline-none"
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label="360 panorama viewer. Drag or use arrow keys to look around. Plus and minus change field of view."
    >
      {!imageUrl && (
        <div className="pointer-events-none absolute inset-0 z-0 flex flex-col items-center justify-center bg-surface-base text-secondary">
          <p className="text-sm font-medium">No panorama selected</p>
          <p className="mt-1 text-xs">Render a graybox pano or import a styled pano. Drag or use arrow keys to look around.</p>
        </div>
      )}
    </div>
  );
}

function createSphere(material: THREE.Material) {
  const geometry = new THREE.SphereGeometry(500, 80, 48);
  geometry.scale(-1, 1, 1);
  return new THREE.Mesh(geometry, material);
}

function configureCamera(camera: THREE.PerspectiveCamera, view: PanoViewState, rotation: Euler) {
  camera.rotation.order = 'YXZ';
  camera.rotation.y = THREE.MathUtils.degToRad(panoYawToThreeJsYawDegrees(view.yawDegrees - rotation[1]));
  camera.rotation.x = THREE.MathUtils.degToRad(view.pitchDegrees);
  camera.rotation.z = 0;
  camera.fov = clampFovDegrees(view.fovDegrees);
  camera.updateProjectionMatrix();
}

function setPanoSphereMaterial(params: {
  sphere: THREE.Mesh | null;
  imageUrl?: string;
  theme: keyof typeof THEME_COLORS;
  opacity: number;
  transparent: boolean;
  isCancelled: () => boolean;
  onMaterialReady: () => void;
}) {
  if (!params.sphere) return;
  if (!params.imageUrl) {
    const material = new THREE.MeshBasicMaterial({ color: THEME_COLORS[params.theme].empty });
    setSphereMaterial(params.sphere, material, params.isCancelled, params.onMaterialReady);
    return;
  }
  new THREE.TextureLoader().load(params.imageUrl, (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      opacity: clamp01(params.opacity),
      transparent: params.transparent,
      depthWrite: !params.transparent,
    });
    setSphereMaterial(params.sphere, material, params.isCancelled, params.onMaterialReady);
  });
}

function setSphereMaterial(
  sphere: THREE.Mesh | null,
  material: THREE.Material,
  isCancelled: () => boolean,
  onMaterialReady: () => void,
) {
  if (isCancelled() || !sphere) {
    disposeMaterial(material);
    return;
  }
  const oldMaterial = sphere.material;
  sphere.material = material;
  disposeMaterial(oldMaterial);
  onMaterialReady();
}

function updateLayerOpacity(
  material: THREE.Material | THREE.Material[] | undefined,
  opacity: number,
  transparent: boolean,
) {
  const materials = Array.isArray(material) ? material : material ? [material] : [];
  for (const item of materials) {
    item.opacity = clamp01(opacity);
    item.transparent = transparent;
    item.depthWrite = !transparent;
    item.needsUpdate = true;
  }
}

function clampFovDegrees(value: number) {
  if (!Number.isFinite(value)) return 65;
  return Math.max(18, Math.min(120, value));
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function normalizeYaw(value: number) {
  return ((value % 360) + 360) % 360;
}

function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry.dispose();
  disposeMaterial(mesh.material);
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((item) => disposeMaterial(item));
    return;
  }
  const texture = (material as THREE.MeshBasicMaterial).map;
  texture?.dispose();
  material.dispose();
}
