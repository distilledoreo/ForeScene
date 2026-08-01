/**
 * Snapshot the Dialogue Demo factory into dialogue-demo.project.json.
 * Factory is canonical; this JSON is a frozen reference for review/diff.
 *
 * Prefer: npm run sample:generate  (assets + this snapshot)
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const { createDialogueDemoSample, DIALOGUE_DEMO_SAMPLE_ID } = await import(
  '../src/engine/sampleProjects.ts'
);

const project = createDialogueDemoSample();
mkdirSync(new URL('../src/samples/', import.meta.url), { recursive: true });
const outPath = new URL('../src/samples/dialogue-demo.project.json', import.meta.url);
const payload = {
  schemaVersion: project.schemaVersion,
  productVersion: project.productVersion,
  sampleId: DIALOGUE_DEMO_SAMPLE_ID,
  note: 'Frozen snapshot of the Dialogue Demo sample. Runtime load/reset uses createDialogueDemoSample() for fresh IDs. Regenerate via npm run sample:generate.',
  project,
};
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log('Wrote', outPath.pathname);
console.log(project.shots.map((s) => `${s.shotNumber}:${s.name}`).join(', '));
