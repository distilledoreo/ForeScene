/**
 * Late-bound render callback so job handlers can invoke the same path as browserApi.renderShotFrame.
 */

import type { AgentRenderShotFrameInput, AgentRenderShotFrameResult } from './protocol';

let renderShotFrameImpl: ((input: AgentRenderShotFrameInput) => Promise<AgentRenderShotFrameResult>) | undefined;

export function setAgentRenderShotFrameImpl(
  impl: (input: AgentRenderShotFrameInput) => Promise<AgentRenderShotFrameResult>,
): void {
  renderShotFrameImpl = impl;
}

export function getAgentRenderShotFrameImpl(): (
  input: AgentRenderShotFrameInput
) => Promise<AgentRenderShotFrameResult> {
  if (!renderShotFrameImpl) {
    throw new Error('Agent render callback is not registered.');
  }
  return renderShotFrameImpl;
}

export function resetAgentRenderShotFrameImplForTests(): void {
  renderShotFrameImpl = undefined;
}
