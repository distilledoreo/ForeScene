import type { AgentShotMaterializationResult } from './protocol';

/**
 * Additive prepared-media API installed by useForeSceneAgentApi.
 * Optional on the base interface so createForeSceneBrowserApi remains usable in
 * non-window/test contexts before the runtime facade augments it.
 */
declare module './protocol' {
  interface ForeSceneBrowserApi {
    captureShotPreparedMedia?: (input: { shotId: string }) => Promise<AgentShotMaterializationResult>;
  }
}

export {};
