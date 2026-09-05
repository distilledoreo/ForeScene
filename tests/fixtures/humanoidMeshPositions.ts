/** Bind-pose humanoid triangles with real depth so cameras see a person, not a paper cutout. */
export const HUMANOID_FIXTURE_POSITIONS = new Float32Array([
  -0.2, 0, 0.12,
  0.2, 0, -0.12,
  0, 1.5, 0.12,
  -0.5, 1, -0.12,
  -0.2, 1, 0.12,
  -0.2, 1.5, -0.12,
]);

export const HUMANOID_FIXTURE_POSITION_MIN: [number, number, number] = [-0.5, 0, -0.12];
export const HUMANOID_FIXTURE_POSITION_MAX: [number, number, number] = [0.2, 1.5, 0.12];
