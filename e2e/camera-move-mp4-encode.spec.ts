import { expect, test } from '@playwright/test';

interface Mp4EncodeHarnessResult {
  done: boolean;
  ok: boolean;
  error?: string;
  frameCount?: number;
  durationSeconds?: number;
  timestampsEven?: boolean;
  allFramesDecoded?: boolean;
  cameraTimeStart?: number;
  cameraTimeEnd?: number;
  firstFrameMae?: number;
  lastFrameMae?: number;
  startEndFrameDelta?: number;
  validationIssues?: Array<{ code: string; message: string }>;
}

test.describe('@heavy camera move MP4 encode integration', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chromium',
      'Real WebCodecs encode/decode runs on desktop Chromium only.',
    );
  });

  test('encodes a 1s 320×180 clip with exact end pose and CFR timestamps', async ({ page }) => {
    await page.goto('/e2e/harness/mp4-encode.html');

    await page.waitForFunction(
      () => Boolean((window as Window & { __mp4EncodeTestResult?: { done?: boolean } }).__mp4EncodeTestResult?.done),
      undefined,
      { timeout: 90_000 },
    );

    const result = await page.evaluate(
      () => (window as Window & { __mp4EncodeTestResult?: Mp4EncodeHarnessResult }).__mp4EncodeTestResult,
    );

    expect(result, 'harness did not publish a result').toBeTruthy();
    expect(result!.error, result!.error).toBeUndefined();
    expect(result!.ok).toBe(true);
    expect(result!.frameCount).toBe(30);
    expect(result!.timestampsEven).toBe(true);
    expect(result!.allFramesDecoded).toBe(true);
    expect(result!.cameraTimeStart).toBe(0);
    expect(result!.cameraTimeEnd).toBe(1);
    expect(result!.durationSeconds).toBeCloseTo(1, 1);
    expect(result!.firstFrameMae ?? 999).toBeLessThan(45);
    expect(result!.lastFrameMae ?? 999).toBeLessThan(45);
    expect(result!.startEndFrameDelta ?? 0).toBeGreaterThan(8);
  });
});
