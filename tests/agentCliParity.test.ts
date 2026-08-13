import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { documentedAgentNpmScript, extractAgentEnvelope } from '../scripts/agent/runDocumentedCli';
import { wrapAgentCliStdout } from '../scripts/agent/cliResult';
import { resolveForeSceneRepoRoot } from '../scripts/agent/repoRoot';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Agent CLI documented parity contract', () => {
  it('keeps the Playwright parity spec on npm run agent:* only', () => {
    const spec = readFileSync(path.join(repoRoot, 'e2e/agent-cli-parity.spec.ts'), 'utf8');
    expect(spec).toContain('runDocumentedAgentCommand');
    expect(spec).toContain("'open'");
    expect(spec).toContain("'inspect'");
    expect(spec).toContain("'import-panorama'");
    expect(spec).toContain("'video'");
    expect(spec).toContain("'save'");
    expect(spec).toContain("'verify'");
    expect(spec).not.toMatch(/window\.foreScene/);
    expect(spec).not.toMatch(/from ['"]\.\.\/src\/engine\/agent/);
    expect(spec).not.toContain('open-package.ts');
    expect(spec).not.toContain('render-stills.ts');
    expect(spec).not.toContain('stable: true');
  });

  it('resolves FORESCENE_REPO_ROOT independently of cwd', () => {
    expect(resolveForeSceneRepoRoot(repoRoot)).toBe(repoRoot);
    expect(documentedAgentNpmScript('inspect')).toBe('agent:inspect');
  });

  it('parses envelopes without treating catalog stability as proof', () => {
    const envelope = extractAgentEnvelope(`${JSON.stringify(wrapAgentCliStdout({
      operation: 'project.inspect',
      startedAt: Date.now() - 5,
    }, { ok: true, shots: [{ shotNumber: '001' }] }), null, 2)}\n`);
    expect(envelope?.ok).toBe(true);
    expect(envelope?.operation).toBe('project.inspect');
    expect(envelope).not.toHaveProperty('stable');
  });
});
