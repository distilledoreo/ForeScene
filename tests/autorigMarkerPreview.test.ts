import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  canvasPointToNdc,
  canvasToWorld,
  computeAutorigOrthoFrame,
  configureAutorigOrthoCamera,
  drawAutorigMarkerMagnifier,
  projectWorldToNdc,
  worldToCanvas,
  type OrientedMeshBounds,
} from '../src/engine/autorigMarkerFrame';
import {
  createAutorigMarkerPreviewGl,
  disposeAutorigMarkerPreviewGl,
  renderAutorigMarkerPreview,
  setAutorigMarkerPreviewRoot,
} from '../src/engine/autorigMarkerPreviewRenderer';
import {
  createAutorigPreviewInstance,
  isAutorigSourceTemplateReady,
  resetAutoriggedCharacterTemplatesForTests,
  setAutorigSourceTemplateForTests,
} from '../src/engine/autoriggedPoseableCharacter';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

afterEach(() => {
  resetAutoriggedCharacterTemplatesForTests();
});

describe('autorig marker orthographic frame (shared mesh + markers)', () => {
  const bounds: OrientedMeshBounds = {
    min: [-0.4, 0, -0.2],
    max: [0.4, 1.8, 0.25],
  };

  it('maps world points to canvas and back within tolerance (front and side)', () => {
    for (const view of ['front', 'side'] as const) {
      const frame = computeAutorigOrthoFrame({
        bounds,
        view,
        canvasWidth: 640,
        canvasHeight: 480,
      });
      // Frame must come from actual bounds, not only approximate height.
      // Vertical range includes mesh height ~1.8 with padding, not a generic 1.15*h alone.
      expect(frame.vertMax - frame.vertMin).toBeGreaterThan(1.5);
      expect(frame.vertMin).toBeLessThan(0.2);

      const samples: Array<[number, number, number]> = [
        [0, 0.9, 0],
        [0.3, 1.5, 0.1],
        [-0.2, 0.2, -0.15],
        [bounds.min[0], bounds.min[1], bounds.min[2]],
        [bounds.max[0], bounds.max[1], bounds.max[2]],
      ];
      for (const world of samples) {
        const pt = worldToCanvas(world, frame);
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThanOrEqual(640);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThanOrEqual(480);
        const back = canvasToWorld(pt.x, pt.y, frame, world);
        // In-plane editable axes round-trip; locked axes preserved from current.
        if (view === 'front') {
          expect(back[0]).toBeCloseTo(world[0], 5);
          expect(back[1]).toBeCloseTo(world[1], 5);
          expect(back[2]).toBe(world[2]);
        } else {
          // Side edits depth Z only; X/Y stay on the pre-drag marker.
          expect(back[2]).toBeCloseTo(world[2], 5);
          expect(back[1]).toBe(world[1]);
          expect(back[0]).toBe(world[0]);
        }
      }
    }
  });

  it('side view canvas mapping only changes world depth Z', () => {
    const frameSide = computeAutorigOrthoFrame({
      bounds,
      view: 'side',
      canvasWidth: 640,
      canvasHeight: 480,
      paddingFraction: 0,
    });
    const current: [number, number, number] = [0.25, 1.2, -0.05];
    const origin = worldToCanvas(current, frameSide);
    // Drag right (deeper Z) and down (would have been lower Y in the old behaviour).
    const moved = canvasToWorld(origin.x + 40, origin.y + 50, frameSide, current);
    expect(moved[0]).toBe(current[0]);
    expect(moved[1]).toBe(current[1]);
    expect(moved[2]).not.toBeCloseTo(current[2], 3);
    expect(moved[2]).toBeGreaterThan(current[2]);
  });

  it('front uses X horizontal and side uses Z horizontal; both use Y vertical', () => {
    const frameFront = computeAutorigOrthoFrame({
      bounds,
      view: 'front',
      canvasWidth: 640,
      canvasHeight: 480,
      paddingFraction: 0,
    });
    const frameSide = computeAutorigOrthoFrame({
      bounds,
      view: 'side',
      canvasWidth: 640,
      canvasHeight: 480,
      paddingFraction: 0,
    });

    // Without aspect fit paddingFraction=0 still expands for canvas aspect — check component mapping.
    const left = worldToCanvas([-0.4, 0.9, 0], frameFront);
    const right = worldToCanvas([0.4, 0.9, 0], frameFront);
    expect(right.x).toBeGreaterThan(left.x);

    const nearZ = worldToCanvas([0, 0.9, -0.2], frameSide);
    const farZ = worldToCanvas([0, 0.9, 0.25], frameSide);
    expect(farZ.x).toBeGreaterThan(nearZ.x);

    const low = worldToCanvas([0, 0, 0], frameFront);
    const high = worldToCanvas([0, 1.8, 0], frameFront);
    expect(high.y).toBeLessThan(low.y); // canvas Y-down
  });

  it('frame from mesh bounds differs from height-only fallback for the same canvas', () => {
    const fromBounds = computeAutorigOrthoFrame({
      bounds,
      view: 'front',
      canvasWidth: 640,
      canvasHeight: 480,
      fallbackHeightMeters: 1.75,
    });
    const heightOnly = computeAutorigOrthoFrame({
      bounds: null,
      view: 'front',
      canvasWidth: 640,
      canvasHeight: 480,
      fallbackHeightMeters: 1.75,
    });
    // Same height fallback would center a 1.15*1.75 span; mesh bounds are asymmetric in X/Z.
    expect(fromBounds.horizMin).not.toBeCloseTo(heightOnly.horizMin, 2);
    // A known world point projects differently under bounds vs assumed span.
    const pBounds = worldToCanvas([0.3, 1.0, 0], fromBounds);
    const pHeight = worldToCanvas([0.3, 1.0, 0], heightOnly);
    expect(Math.hypot(pBounds.x - pHeight.x, pBounds.y - pHeight.y)).toBeGreaterThan(1);
  });

  it('configureAutorigOrthoCamera sets distinct eye positions for front vs side', () => {
    const frameFront = computeAutorigOrthoFrame({ bounds, view: 'front', canvasWidth: 640, canvasHeight: 480 });
    const frameSide = computeAutorigOrthoFrame({ bounds, view: 'side', canvasWidth: 640, canvasHeight: 480 });
    const cam = new THREE.OrthographicCamera();
    configureAutorigOrthoCamera(cam, frameFront);
    const frontPos = cam.position.clone();
    configureAutorigOrthoCamera(cam, frameSide);
    const sidePos = cam.position.clone();
    expect(frontPos.distanceTo(sidePos)).toBeGreaterThan(0.1);
    // Front camera sits further along +Z; side sits on −X looking +X (not +X looking −X).
    expect(frontPos.z).toBeGreaterThan(sidePos.z);
    expect(sidePos.x).toBeLessThan(frontPos.x);
  });

  it('WebGL NDC from configureAutorigOrthoCamera matches worldToCanvas for front and side', () => {
    const samples: Array<[number, number, number]> = [
      [0, 0.9, 0],
      [0.3, 1.5, 0.1],
      [-0.2, 0.2, -0.15],
      [bounds.min[0], bounds.min[1], bounds.min[2]],
      [bounds.max[0], bounds.max[1], bounds.max[2]],
    ];
    for (const view of ['front', 'side'] as const) {
      const frame = computeAutorigOrthoFrame({
        bounds,
        view,
        canvasWidth: 640,
        canvasHeight: 480,
      });
      const camera = new THREE.OrthographicCamera();
      for (const world of samples) {
        const canvas = worldToCanvas(world, frame);
        const fromCanvas = canvasPointToNdc(canvas.x, canvas.y, frame);
        const fromCamera = projectWorldToNdc(world, frame, camera);
        expect(fromCamera.x).toBeCloseTo(fromCanvas.x, 4);
        expect(fromCamera.y).toBeCloseTo(fromCanvas.y, 4);
      }
      // Explicit anti-mirror: larger horizontal world must increase both NDC x and canvas x.
      const lo = view === 'front' ? ([-0.3, 0.9, 0] as const) : ([0, 0.9, -0.15] as const);
      const hi = view === 'front' ? ([0.3, 0.9, 0] as const) : ([0, 0.9, 0.2] as const);
      const ndcLo = projectWorldToNdc([...lo], frame, camera);
      const ndcHi = projectWorldToNdc([...hi], frame, camera);
      const cLo = worldToCanvas([...lo], frame);
      const cHi = worldToCanvas([...hi], frame);
      expect(ndcHi.x).toBeGreaterThan(ndcLo.x);
      expect(cHi.x).toBeGreaterThan(cLo.x);
    }
  });
});

describe('autorig preview instance reuses template cache', () => {
  it('createAutorigPreviewInstance uses injected template without a second GLB path', () => {
    const geo = new THREE.BoxGeometry(0.5, 1.7, 0.3);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    const group = new THREE.Group();
    group.add(mesh);
    setAutorigSourceTemplateForTests('src_preview', group);

    expect(isAutorigSourceTemplateReady('src_preview')).toBe(true);
    const preview = createAutorigPreviewInstance({
      sourceAssetId: 'src_preview',
      approximateHeightMeters: 1.75,
      orientation: { frontAxis: '+z', upAxis: '+y', groundLevelMeters: 0 },
    });
    expect(preview).toBeTruthy();
    expect(preview!.bounds.max[1] - preview!.bounds.min[1]).toBeGreaterThan(1.5);
    // Grounded: min Y near 0
    expect(preview!.bounds.min[1]).toBeCloseTo(0, 2);
    // Light/transparent material for marker readability
    let foundTransparent = false;
    preview!.root.traverse((node) => {
      const m = node as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.transparent && mat.opacity < 1) foundTransparent = true;
    });
    expect(foundTransparent).toBe(true);
  });

  it('wizard wiring resolves sourceAssetId from rig fields (structural + helper path)', () => {
    // Shipped dialog accepts sourceAssetId + assets; BuildWorkspace passes
    // rig.originalSourceAssetId ?? rig.sourceMeshAssetId and project.assets.
    const source = readFileSync(
      resolve('src/components/workspaces/BuildWorkspace.tsx'),
      'utf8',
    );
    expect(source).toMatch(/sourceAssetId=\{rig\.originalSourceAssetId \?\? rig\.sourceMeshAssetId\}/);
    expect(source).toMatch(/assets=\{project\.assets\}/);
    const dialog = readFileSync(
      resolve('src/components/common/AutorigMarkerWizardDialog.tsx'),
      'utf8',
    );
    expect(dialog).toMatch(/createAutorigPreviewInstance/);
    expect(dialog).toMatch(/ensureAutorigSourceTemplate/);
    expect(dialog).toMatch(/data-autorig-mesh-canvas/);
    expect(dialog).toMatch(/pointer-events-none/);
    // No continuous animation loop in wizard.
    expect(dialog).not.toMatch(/requestAnimationFrame/);
  });
});

describe('autorig marker preview WebGL lifecycle', () => {
  it('render path is on-demand only and dispose releases the renderer', () => {
    const dispose = vi.fn();
    const loseContext = vi.fn();
    const render = vi.fn();
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    const canvas = { width: 64, height: 48 } as HTMLCanvasElement;
    const gl = {
      canvas,
      renderer: {
        dispose,
        render,
        getContext: () => ({ getExtension: () => ({ loseContext }) }),
        setSize: vi.fn(),
        setPixelRatio: vi.fn(),
        setClearColor: vi.fn(),
      } as unknown as THREE.WebGLRenderer,
      scene,
      camera,
      root: null as THREE.Object3D | null,
      renderCount: 0,
      hasContinuousLoop: false as const,
    };

    expect(gl.hasContinuousLoop).toBe(false);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.25), new THREE.MeshBasicMaterial());
    setAutorigMarkerPreviewRoot(gl, box);
    expect(gl.root).toBe(box);

    const frame = computeAutorigOrthoFrame({
      bounds: { min: [-0.2, 0, -0.12], max: [0.2, 1.6, 0.12] },
      view: 'front',
      canvasWidth: 64,
      canvasHeight: 48,
    });
    renderAutorigMarkerPreview(gl, frame);
    renderAutorigMarkerPreview(gl, frame);
    expect(gl.renderCount).toBe(2);
    expect(render).toHaveBeenCalledTimes(2);

    disposeAutorigMarkerPreviewGl(gl);
    expect(dispose).toHaveBeenCalledTimes(1);
    // Must NOT force-lose: React Strict Mode remounts on the same canvas, and
    // loseContext permanently paints Chrome's sad-face glyph on the element.
    expect(loseContext).not.toHaveBeenCalled();
    expect(gl.root).toBeNull();

    // Factory + wizard must not start a continuous rAF loop.
    const factorySrc = readFileSync(
      resolve('src/engine/autorigMarkerPreviewRenderer.ts'),
      'utf8',
    );
    expect(factorySrc).toMatch(/hasContinuousLoop:\s*false/);
    // No continuous loop scheduling API in the shipped factory.
    expect(factorySrc).not.toMatch(/requestAnimationFrame\s*\(/);
    expect(factorySrc).toMatch(/disposeAutorigMarkerPreviewGl/);
    expect(factorySrc).not.toMatch(/loseContext/);
    // renderAutorigMarkerPreview is a single-shot call (no scheduling).
    expect(factorySrc).toMatch(/Single on-demand frame/);
    expect(factorySrc).toMatch(/setClearColor\(0x1c1f26/);
  });
});

describe('autorig marker magnifier samples mesh canvas', () => {
  it('drawAutorigMarkerMagnifier uses drawImage from mesh canvas (not only a solid disc)', () => {
    const drawImage = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      clip: vi.fn(),
      fillRect: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      drawImage,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;

    const meshCanvas = { width: 200, height: 200 } as HTMLCanvasElement;
    drawAutorigMarkerMagnifier({
      ctx,
      meshCanvas,
      markerCanvasX: 100,
      markerCanvasY: 100,
      magnifierCenterX: 140,
      magnifierCenterY: 60,
      radius: 40,
      zoom: 2,
      markerFill: '#22c55e',
    });

    expect(drawImage).toHaveBeenCalled();
    const first = drawImage.mock.calls[0]!;
    expect(first[0]).toBe(meshCanvas);
    // 9-arg drawImage crop: source x,y,w,h + dest x,y,w,h
    expect(first.length).toBe(9);
    // zoom=2, radius=40 → source half-size 20
    expect(first[3]).toBeCloseTo(40); // src width = 2 * (radius/zoom)
    expect(first[4]).toBeCloseTo(40);

    drawImage.mockClear();
    drawAutorigMarkerMagnifier({
      ctx,
      meshCanvas: null,
      markerCanvasX: 100,
      markerCanvasY: 100,
      magnifierCenterX: 140,
      magnifierCenterY: 60,
      markerFill: '#22c55e',
    });
    expect(drawImage).not.toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalled();

    const dialog = readFileSync(
      resolve('src/components/common/AutorigMarkerWizardDialog.tsx'),
      'utf8',
    );
    expect(dialog).toMatch(/drawAutorigMarkerMagnifier/);
    expect(dialog).toMatch(/meshCanvas:\s*meshCanvasRef\.current/);
  });
});