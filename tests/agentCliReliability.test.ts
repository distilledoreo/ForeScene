import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractAgentOpHeartbeats,
  parseAgentOpHeartbeatLine,
} from '../scripts/agent/runDocumentedCli';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Agent CLI live operation reliability contract', () => {
  it('keeps the soak on documented import-character commands', () => {
    const soak = readFileSync(path.join(repoRoot, 'scripts/agent/savedRigSoak.ts'), 'utf8');
    expect(soak).toContain("command: 'import-character'");
    expect(soak).toContain('runDocumentedAgentCommand');
    expect(soak).toContain('retries: 0');
    expect(soak).not.toMatch(/window\.foreScene/);
    expect(soak).not.toMatch(/kill\(['"]SIGKILL/);
  });

  it('keeps the live reliability spec on documented npm run agent:* commands', () => {
    const spec = readFileSync(path.join(repoRoot, 'e2e/agent-operation-reliability.spec.ts'), 'utf8');
    expect(spec).toContain('soak-saved-rig');
    expect(spec).toContain("'cancel'");
    expect(spec).toContain('soak-saved-rig');
    expect(spec).toContain('startDocumentedAgentCommand');
    expect(spec).not.toMatch(/window\.foreScene/);
    expect(spec).not.toMatch(/from ['"]\.\.\/src\/engine\/agent/);
    expect(spec).not.toMatch(/SIGKILL/);
    expect(spec).not.toContain('stable: true');
  });

  it('parses stderr [agent-op] heartbeats without treating stdout envelopes as heartbeats', () => {
    const stderr = [
      '[agent-op] {"event":"heartbeat","operationId":"op_1","type":"render.video.clay","state":"running","progress":0.1,"elapsedMs":5000,"heartbeatCount":1}',
      '[agent-op] {"event":"heartbeat","operationId":"op_1","type":"render.video.clay","state":"progress","progress":0.2,"elapsedMs":10000,"heartbeatCount":2}',
    ].join('\n');
    const beats = extractAgentOpHeartbeats(stderr);
    expect(beats).toHaveLength(2);
    expect(beats[1]?.heartbeatCount).toBe(2);
    expect(parseAgentOpHeartbeatLine('{ "ok": true }')).toBeUndefined();
  });
});
