let active = false;

export function isAgentShotVideoRenderActive(): boolean {
  return active;
}

export function setAgentShotVideoRenderActive(value: boolean): void {
  active = value;
}
