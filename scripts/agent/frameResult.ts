/**
 * Frame-result envelope shaping for the Agent CLI.
 *
 * The render API returns the canonical PNG twice (`artifact.dataUrl` inline
 * payload and `pngDataUrl`). The CLI writes those bytes to --output and must
 * not repeat them in the stdout envelope; it publishes the output path,
 * sha256, byteLength, and the resolved canonical shot identity instead so the
 * artifact stays revision-bound without multi-megabyte JSON.
 */

import { createHash } from 'node:crypto';
import type { AgentRenderShotFrameResult } from '../../src/engine/agent/protocol';
import type { AgentRenderAppearance } from './cliCapabilities';

export type FrameCliResult = Omit<AgentRenderShotFrameResult, 'artifact' | 'pngDataUrl'> & {
  output: string;
  sha256: string;
  byteLength: number;
  appearance: AgentRenderAppearance;
  /** Canonical shot number for the resolved selector (echoed with shotId). */
  shotNumber?: string;
};

export function buildFrameCliResult(params: {
  result: AgentRenderShotFrameResult;
  output: string;
  appearance: AgentRenderAppearance;
  bytes: Buffer;
  shotNumber?: string;
}): FrameCliResult {
  const { result, output, appearance, bytes, shotNumber } = params;
  // The CLI owns the file artifact; never echo inline payloads on stdout.
  const { artifact: _artifact, pngDataUrl: _pngDataUrl, ...withoutInlinePayload } = result;
  return {
    ...withoutInlinePayload,
    output,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteLength: bytes.byteLength,
    appearance,
    ...(shotNumber !== undefined ? { shotNumber } : {}),
  };
}
