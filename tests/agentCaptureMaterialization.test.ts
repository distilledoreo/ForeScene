import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Structural + type-surface proofs that agent capture returns the GOAL materialization shape
 * and never reports ready on primary failure.
 */
describe('agent capture materialization contract', () => {
  const browserApi = readFileSync(
    new URL('../src/engine/agent/browserApi.ts', import.meta.url),
    'utf8',
  );
  const protocol = readFileSync(
    new URL('../src/engine/agent/protocol.ts', import.meta.url),
    'utf8',
  );

  it('declares AgentShotMaterializationResult with required fields', () => {
    expect(protocol).toContain('export interface AgentShotMaterializationResult');
    expect(protocol).toContain("status: 'ready' | 'ready-with-warnings' | 'failed'");
    expect(protocol).toContain('primaryStillAssetId?: string');
    expect(protocol).toContain('artifacts: AgentShotMaterializationArtifact[]');
    expect(protocol).toContain('warnings: string[]');
    expect(protocol).toContain(
      'captureShotThumbnail(input: { shotId: string; timeSeconds?: number }): Promise<AgentShotMaterializationResult>',
    );
  });

  it('captureShotThumbnail returns failed status on primary materialization failure', () => {
    // Failure branch must set status failed and ok false — never return legacy render as success.
    expect(browserApi).toContain("status: 'failed' as const");
    expect(browserApi).toContain('Primary still materialization failed');
    // Must not return the raw renderShotFrame success path after primary failure.
    const failureBlockStart = browserApi.indexOf("if (result.status === 'failed')");
    expect(failureBlockStart).toBeGreaterThan(0);
    const failureBlock = browserApi.slice(failureBlockStart, failureBlockStart + 1200);
    expect(failureBlock).toContain("status: 'failed'");
    expect(failureBlock).toContain('ok: false');
    expect(failureBlock).not.toContain('return rendered');
  });

  it('success path returns primaryStillAssetId and artifacts', () => {
    expect(browserApi).toContain('primaryStillAssetId: primaryId');
    expect(browserApi).toContain('artifacts,');
    expect(browserApi).toContain("mode: 'await-all'");
  });

  it('exposes regenerate/retry/cancel still actions on the agent API', () => {
    expect(protocol).toContain('regenerateShotStills');
    expect(protocol).toContain('retryFailedShotStills');
    expect(protocol).toContain('cancelShotStillPreparation');
    expect(browserApi).toContain('async regenerateShotStills');
    expect(browserApi).toContain('async retryFailedShotStills');
    expect(browserApi).toContain('cancelShotStillPreparation(input)');
  });
});
