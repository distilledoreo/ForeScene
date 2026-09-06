import type { SceneObject } from '../domain/types';

/** Shared by the renderer and its deterministic visual preflight. */
export function shouldReceiveProjectedStyle(object: SceneObject): boolean {
  if (object.category === 'helper' || object.category === 'landmark') return false;
  if (object.type === 'sun_marker' || object.type === 'human_dummy') return false;
  // Imported assets retain their authored appearance and remain visible.
  if (object.type === 'imported_model') return false;
  if (object.stagingRole === 'person' || object.stagingRole === 'prop') return false;
  return true;
}

/** Panorama-backed renders omit duplicate set proxies, but retain ground planes. */
export function isHiddenProjectedSetProxy(object: SceneObject): boolean {
  return object.stagingRole === 'set'
    && object.type !== 'floor'
    && object.type !== 'terrain_mass'
    && shouldReceiveProjectedStyle(object);
}
