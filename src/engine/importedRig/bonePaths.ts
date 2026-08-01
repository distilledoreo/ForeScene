import * as THREE from 'three';

function segmentForNode(node: THREE.Object3D): string {
  const siblings = node.parent?.children ?? [];
  const index = siblings.indexOf(node);
  const name = node.name.trim() || node.type || 'Node';
  return `${name}[${Math.max(0, index)}]`;
}

/** Return a deterministic path relative to the imported hierarchy root. */
export function getRootRelativeNodePath(root: THREE.Object3D, node: THREE.Object3D): string {
  const chain: THREE.Object3D[] = [];
  let current: THREE.Object3D | null = node;
  while (current && current !== root) {
    chain.push(current);
    current = current.parent;
  }
  if (current !== root) throw new Error('Node does not belong to the supplied source root.');
  return chain.reverse().map(segmentForNode).join('/');
}

function parseSegment(segment: string): { name: string; index: number } | undefined {
  const match = segment.match(/^(.*)\[(\d+)\]$/);
  if (!match) return undefined;
  return { name: match[1]!, index: Number(match[2]) };
}

/** Resolve a path produced by {@link getRootRelativeNodePath}. */
export function resolveRootRelativeNodePath(root: THREE.Object3D, path: string): THREE.Object3D | undefined {
  let current: THREE.Object3D = root;
  for (const segment of path.split('/').filter(Boolean)) {
    const parsed = parseSegment(segment);
    if (!parsed) return undefined;
    current = current.children[parsed.index];
    if (!current || (current.name.trim() || current.type) !== parsed.name) return undefined;
  }
  return current;
}

export function buildBonePathMap(root: THREE.Object3D, bones: readonly THREE.Bone[]): Map<string, THREE.Bone> {
  return new Map(bones.map((bone) => [getRootRelativeNodePath(root, bone), bone]));
}
