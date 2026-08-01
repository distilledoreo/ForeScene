import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Prefer tsx loader path via dynamic import of compiled-through-tsx
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
  note: 'Frozen snapshot of the Dialogue Demo sample. Runtime load/reset uses createDialogueDemoSample() for fresh IDs.',
  project,
};
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log('Wrote', outPath.pathname);
console.log(project.shots.map((s) => `${s.shotNumber}:${s.name}`).join(', '));
