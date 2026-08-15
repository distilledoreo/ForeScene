import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const planPath = process.env.FORESCENE_AGENT_PLAN;
if (!planPath) {
  process.stderr.write('FORESCENE_AGENT_PLAN is required.\n');
  process.exit(2);
}

await copyFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'v3AgentFakeB.plan.json'),
  planPath,
);
process.stdout.write('fake-b wrote candidate-plan.json\n');
