/**
 * Registers `window.foreScene` idempotently.
 * Identity check matters under React Strict Mode double-mount.
 */

import { useEffect } from 'react';
import { createForeSceneBrowserApi } from '../engine/agent/browserApi';

export function useForeSceneAgentApi(): void {
  useEffect(() => {
    const api = createForeSceneBrowserApi();
    window.foreScene = api;

    return () => {
      if (window.foreScene === api) {
        delete window.foreScene;
      }
    };
  }, []);
}
