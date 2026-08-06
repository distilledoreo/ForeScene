import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (
  navigator.webdriver
  && new URLSearchParams(window.location.search).has('__foresceneVideoCacheTest')
) {
  void import('./engine/videoArtifactCache').then((cache) => {
    Object.defineProperty(window, '__foreSceneVideoCacheTest', {
      configurable: true,
      value: {
        applyEstimatedBudget: cache.applyEstimatedVideoCacheBudget,
        clear: cache.clearVideoArtifactCache,
        clearMemory: cache.clearVideoArtifactMemoryCacheForTests,
        flush: cache.flushVideoArtifactCacheOperationsForTests,
        get: cache.getVideoArtifactFromCache,
        inspect: cache.inspectVideoArtifactCache,
        put: cache.putVideoArtifactInCache,
        setMemoryLimits: cache.setVideoArtifactMemoryCacheLimits,
        setPersistentLimits: cache.setVideoArtifactCacheLimits,
      },
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);