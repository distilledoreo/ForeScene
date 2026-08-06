import { expect, test } from '@playwright/test';

test('@smoke video artifact cache persists blobs and enforces late quota changes', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Chromium is the supported persistent MP4-cache gate; WebKit does not preserve Blob rows in this runner.',
  );

  await page.goto('/?__foresceneVideoCacheTest=1');
  await page.waitForFunction(() => Boolean(
    (window as typeof window & { __foreSceneVideoCacheTest?: unknown }).__foreSceneVideoCacheTest,
  ));

  const result = await page.evaluate(async () => {
    type Fingerprint = {
      key: string;
      dependencyIds: string[];
      details: {
        rendererVersion: string;
        shotId: string;
        appearance: 'clay';
        width: number;
        height: number;
        frameRate: number;
        encoderMode: 'fast';
        contentMode: 'full_scene';
      };
    };
    type CacheHarness = {
      applyEstimatedBudget: () => Promise<unknown>;
      clear: () => Promise<void>;
      clearMemory: () => void;
      flush: () => Promise<void>;
      get: (fingerprint: { key: string }) => Promise<{ blob: Blob } | undefined>;
      inspect: () => { memoryEntries: number };
      put: (
        fingerprint: Fingerprint,
        record: {
          blob: Blob;
          mimeType: string;
          width: number;
          height: number;
          durationSeconds: number;
          frameRate: number;
          frameCount: number;
          encodeMode: 'render';
          actualEncoderMode: 'fast';
          encoderModeFallback: boolean;
        },
      ) => Promise<unknown>;
      setMemoryLimits: (limits: { maxBytes?: number; maxEntries?: number }) => unknown;
      setPersistentLimits: (limits: { maxBytes?: number; maxEntries?: number }) => unknown;
    };

    const cache = (window as typeof window & { __foreSceneVideoCacheTest: CacheHarness })
      .__foreSceneVideoCacheTest;
    const fingerprint = (key: string): Fingerprint => ({
      key,
      dependencyIds: [`shot:${key}`],
      details: {
        rendererVersion: 'e2e',
        shotId: key,
        appearance: 'clay',
        width: 1280,
        height: 720,
        frameRate: 24,
        encoderMode: 'fast',
        contentMode: 'full_scene',
      },
    });
    const record = (bytes: number[]) => ({
      blob: new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 1,
      frameRate: 24,
      frameCount: 24,
      encodeMode: 'render' as const,
      actualEncoderMode: 'fast' as const,
      encoderModeFallback: false,
    });

    await cache.clear();
    await cache.applyEstimatedBudget();
    cache.setPersistentLimits({ maxBytes: 1024 * 1024, maxEntries: 10 });
    cache.setMemoryLimits({ maxBytes: 1024 * 1024, maxEntries: 10 });

    const durableKey = 'video:e2e-durable-roundtrip';
    await cache.put(fingerprint(durableKey), record([3, 1, 4, 1, 5]));
    await cache.flush();
    cache.clearMemory();
    const memoryEntriesBeforeRead = cache.inspect().memoryEntries;
    const durableHit = await cache.get({ key: durableKey });
    const durableBytes = durableHit
      ? [...new Uint8Array(await durableHit.blob.arrayBuffer())]
      : [];

    await cache.clear();
    await cache.applyEstimatedBudget();
    cache.setPersistentLimits({ maxBytes: 1024, maxEntries: 10 });
    cache.setMemoryLimits({ maxBytes: 1024, maxEntries: 10 });

    const oversizedAfterShrinkKey = 'video:e2e-late-quota-shrink';
    await cache.put(
      fingerprint(oversizedAfterShrinkKey),
      record([...new Uint8Array(80)]),
    );
    // Shrink after put() schedules persistence but before the queued IDB write
    // resumes. writeStored must recheck the active limit and skip/delete it.
    cache.setPersistentLimits({ maxBytes: 40 });
    await cache.flush();
    cache.clearMemory();
    const oversizedHit = await cache.get({ key: oversizedAfterShrinkKey });

    await cache.clear();
    return {
      memoryEntriesBeforeRead,
      durableBytes,
      oversizedPersisted: Boolean(oversizedHit),
    };
  });

  expect(result.memoryEntriesBeforeRead).toBe(0);
  expect(result.durableBytes).toEqual([3, 1, 4, 1, 5]);
  expect(result.oversizedPersisted).toBe(false);
});
