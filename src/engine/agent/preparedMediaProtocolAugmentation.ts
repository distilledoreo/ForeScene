import type { AgentShotMaterializationResult } from './protocol';

/**
 * Compatibility declaration retained for older imports. The prepared-media
 * method is now part of the canonical browser API contract.
 */
declare module './protocol' {
  interface ForeSceneBrowserApi {
    captureShotPreparedMedia: (input: { shotId: string }) => Promise<AgentShotMaterializationResult>;
  }
}

export {};
