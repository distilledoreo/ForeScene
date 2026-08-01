import { expect, test, type Page } from '@playwright/test';

import { enterStudioWorkspace } from './helpers/app-entry';
import { workspaceTab } from './workspace-navigation';

function dismissOverlays(page: Page) {
  return (async () => {
    for (const label of ['Got it', 'Not right now', 'Start checking', 'Close']) {
      const button = page.getByRole('button', { name: label, exact: true });
      if (await button.isVisible().catch(() => false)) await button.click({ force: true }).catch(() => undefined);
    }
  })();
}

/** Small self-contained GLB with one skinned mesh and a Mixamo-style skeleton. */
function preservedRigGlb(): Buffer {
  const nodes: Array<Record<string, unknown>> = [];
  const add = (name: string, translation: [number, number, number], children: number[] = []) => {
    const index = nodes.length;
    nodes.push({ name, translation, ...(children.length ? { children } : {}) });
    return index;
  };
  const armature = add('Armature', [0, 0, 0]);
  const hips = add('mixamorig:Hips', [0, 1, 0]);
  const spine = add('mixamorig:Spine', [0, 0.65, 0]);
  const head = add('mixamorig:Head', [0, 0.65, 0]);
  const leftArm = add('mixamorig:LeftArm', [-0.35, 0.35, 0]);
  const leftForeArm = add('mixamorig:LeftForeArm', [-0.35, 0, 0]);
  const leftHand = add('mixamorig:LeftHand', [-0.25, 0, 0]);
  const rightArm = add('mixamorig:RightArm', [0.35, 0.35, 0]);
  const rightForeArm = add('mixamorig:RightForeArm', [0.35, 0, 0]);
  const rightHand = add('mixamorig:RightHand', [0.25, 0, 0]);
  const leftUpLeg = add('mixamorig:LeftUpLeg', [-0.2, -0.8, 0]);
  const leftLeg = add('mixamorig:LeftLeg', [0, -0.8, 0]);
  const leftFoot = add('mixamorig:LeftFoot', [0, -0.2, 0.15]);
  const rightUpLeg = add('mixamorig:RightUpLeg', [0.2, -0.8, 0]);
  const rightLeg = add('mixamorig:RightLeg', [0, -0.8, 0]);
  const rightFoot = add('mixamorig:RightFoot', [0, -0.2, 0.15]);
  const meshNode = add('CharacterMesh', [0, 0, 0]);
  nodes[armature]!.children = [hips, meshNode];
  nodes[hips]!.children = [spine, leftUpLeg, rightUpLeg];
  nodes[spine]!.children = [head, leftArm, rightArm];
  nodes[leftArm]!.children = [leftForeArm];
  nodes[leftForeArm]!.children = [leftHand];
  nodes[rightArm]!.children = [rightForeArm];
  nodes[rightForeArm]!.children = [rightHand];
  nodes[leftUpLeg]!.children = [leftLeg];
  nodes[leftLeg]!.children = [leftFoot];
  nodes[rightUpLeg]!.children = [rightLeg];
  nodes[rightLeg]!.children = [rightFoot];

  const jointNodes = [hips, spine, head, leftArm, leftForeArm, leftHand, rightArm, rightForeArm, rightHand, leftUpLeg, leftLeg, leftFoot, rightUpLeg, rightLeg, rightFoot];
  const positions = Buffer.from(new Float32Array([
    -0.2, 0, 0, 0.2, 0, 0, 0, 1.5, 0,
    -0.5, 1, 0, -0.2, 1, 0, -0.2, 1.5, 0,
  ]).buffer);
  const joints = Buffer.from(new Uint8Array([
    9, 0, 0, 0, 12, 0, 0, 0, 1, 0, 0, 0,
    3, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
  ]).buffer);
  const weights = Buffer.from(new Float32Array([
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
  ]).buffer);
  const inverseBind = Buffer.alloc(jointNodes.length * 64);
  for (let index = 0; index < jointNodes.length; index += 1) {
    inverseBind.writeFloatLE(1, index * 64);
    inverseBind.writeFloatLE(1, index * 64 + 20);
    inverseBind.writeFloatLE(1, index * 64 + 40);
    inverseBind.writeFloatLE(1, index * 64 + 60);
  }
  const bin = Buffer.concat([positions, joints, weights, inverseBind]);
  const gltf = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: joints.length },
      { buffer: 0, byteOffset: positions.length + joints.length, byteLength: weights.length },
      { buffer: 0, byteOffset: positions.length + joints.length + weights.length, byteLength: inverseBind.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [-0.5, 0, 0], max: [0.2, 1.5, 0] },
      { bufferView: 1, componentType: 5121, count: 6, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 6, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: jointNodes.length, type: 'MAT4' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    skins: [{ joints: jointNodes, skeleton: hips, inverseBindMatrices: 3 }],
    nodes: nodes.map((node, index) => index === meshNode ? { ...node, mesh: 0, skin: 0 } : node),
    scenes: [{ nodes: [armature] }],
    scene: 0,
  };
  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPadding)]);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = Buffer.alloc(totalLength);
  let offset = 0;
  glb.write('glTF', offset, 4, 'ascii'); offset += 4;
  glb.writeUInt32LE(2, offset); offset += 4;
  glb.writeUInt32LE(totalLength, offset); offset += 4;
  glb.writeUInt32LE(jsonChunk.length, offset); offset += 4;
  glb.writeUInt32LE(0x4e4f534a, offset); offset += 4;
  jsonChunk.copy(glb, offset); offset += jsonChunk.length;
  glb.writeUInt32LE(binChunk.length, offset); offset += 4;
  glb.writeUInt32LE(0x004e4942, offset); offset += 4;
  binChunk.copy(glb, offset);
  return glb;
}

test('preserves a Mixamo-style rig and applies a semantic pose', async ({ page }) => {
  await enterStudioWorkspace(page);
  await dismissOverlays(page);
  await workspaceTab(page, 'Build').click();
  await dismissOverlays(page);
  await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
  await page.locator('[data-build-import-poseable-character]').click();

  const dialog = page.getByRole('dialog', { name: /Import poseable character/i });
  await dialog.locator('[data-poseable-import-mesh-input]').setInputFiles({
    name: 'preserved-mixamo.glb',
    mimeType: 'model/gltf-binary',
    buffer: preservedRigGlb(),
  });
  await expect(dialog.locator('[data-poseable-import-rig-summary]')).toBeVisible({ timeout: 15000 });
  await expect(dialog.locator('[data-poseable-import-preserve-rig]')).toBeEnabled();
  await expect(dialog.getByText('Use existing rig', { exact: true })).toBeVisible();
  await dialog.locator('[data-poseable-import-confirm]').click();
  await expect(dialog).toBeHidden({ timeout: 15000 });

  await page.locator('[data-character-mode-pose]').click();
  await expect(page.locator('[data-build-character-pose]')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Arms raised/i }).click();
  await expect(page.locator('[data-build-character-pose]')).toBeVisible();
});
