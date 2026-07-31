import type { ForeSceneBrowserApi } from '../engine/agent/protocol';

declare global {
  interface Window {
    foreScene?: ForeSceneBrowserApi;
  }
}

export {};
