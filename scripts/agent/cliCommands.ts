/**
 * Shared Agent CLI command inventory for help, discovery, and tests.
 */

export const AGENT_CLI_COMMANDS = [
  'capabilities',
  'inspect',
  'open',
  'save',
  'cancel',
  'operations',
  'preview',
  'apply',
  'screenshot',
  'frame',
  'video',
  'package',
  'verify',
  'visual-preflight',
  'asset-contract',
  'world-preview',
  'world-mock',
  'world-depth',
  'run',
  'previs',
  'production',
  'render-stills',
  'contact-sheet',
  'render-passes',
  'plan-exports',
  'verify-package',
  'refine',
  'analyze-character',
  'import-character',
  'import-model',
  'import-panorama',
  'shot-panorama',
  'replace-proxy',
  'help',
] as const;

export type AgentCliCommand = (typeof AGENT_CLI_COMMANDS)[number];

export function isAgentCliCommand(value: string): value is AgentCliCommand {
  return (AGENT_CLI_COMMANDS as readonly string[]).includes(value);
}

export function buildAgentCliHelpDocument() {
  return {
    commands: [...AGENT_CLI_COMMANDS],
    checks: {
      visualPreflight: 'collectVisualPreflightValidation via `visual-preflight` or `verify`. Omitted --shots validates every shot. Explicit --shot/--shots is passed through; unknown or empty explicit selection fails, and unmatched ids appear in the JSON result and provenance. visualPreflight: [] is never a passed gate. Empty projects omit the visual gate (skipped).',
      assetPoseContract: 'inspectAssetPoseContract via `asset-contract` or `verify`. `asset-contract` accepts one optional --shot (API shotId); omit the flag for the whole project. Multiple ids are rejected.',
      generativeWorldBoundary: '`world-preview` emits the backend-neutral request plus HY-World 2 camera-prior JSON; `world-mock` exercises the deterministic adapter without running external inference; `world-depth` emits a raw float32 camera-Z .npy prior.',
      repairCandidates: 'begin/evaluate/commitBestShotRepairCandidate inside `previs` repair',
      provenance: 'getStatus().provenance on verify, package, previs, and video (per-invocation runId, retries, cancelled, revision-bound validation)',
      resumeCancel: 'Ctrl+C / SIGINT or `npm run agent:cancel -- --operation <id>` cancels package, video, still, and character-import jobs; previs resumes from run-state.json',
      recoveryResources: '`package` and `exportProjectBackup` reconcile recovery binaries before export',
    },
    discovery: {
      cliCapabilities: '`npm run agent:capabilities` — canonical public surface; no browser required',
      describeCapabilities: 'window.foreScene.describeCapabilities() — browser API only; prefer CLI capabilities',
      describeOperation: 'window.foreScene.describeOperation(name)',
      getAgentSchema: 'window.foreScene.getAgentSchema()',
    },
    renderModes: {
      frame: 'Clay, projected, and depth are `--mode` (alias `--appearance`) on `frame`. Default clay.',
      video: 'Same `--mode` / `--appearance` contract as `frame`.',
    },
    projectLifecycle: {
      open: '`open --file <package.fsp> --write` stages the package and calls openProjectPackage.',
      save: '`save --output <package.fsp> --write` flushes, rehydrates, then exports a verified `.fsp` backup whose embedded project.json and binaries are inspected.',
      profile: 'Stateful commands require `--profile <dir>`. The default `.forescene-agent/browser-profile` is refused. The resolved path is recorded on the CLI envelope.',
    },
    operations: {
      lifecycle: 'requested → accepted → running → progress → completed | failed | cancelled',
      heartbeat: 'stderr `[agent-op]` JSON every 5s while a heavy command is alive',
      cancel: '`npm run agent:cancel -- --operation <id>` (or omit --operation to cancel the latest active run)',
      profileLocks: 'openAgentBrowser removes stale Chromium SingletonLock files when the owner pid is dead',
    },
    runIdentity: {
      runId: 'Generated per CLI invocation and published as getStatus().provenance.cli.runId',
      sourceCommit: 'Included only when FORESCENE_SOURCE_COMMIT / GITHUB_SHA / VITE_GIT_COMMIT is set',
      buildId: 'Included only when FORESCENE_BUILD_ID / VITE_BUILD_ID is set',
    },
    shotSelection: {
      verify: 'Optional --shot/--shots. Omitted validates every shot (empty projects skip the visual gate). Explicit unknown or empty selection fails collectVisualPreflightValidation; unmatched ids appear in the JSON result and provenance.',
      visualPreflight: 'Same --shot/--shots contract as verify.',
      frame: 'Exactly one --shot (or a single --shots value). Additional ids are rejected before the browser opens.',
      video: 'Exactly one --shot (or a single --shots value). Additional ids are rejected before the browser opens.',
      shotPanorama: 'Exactly one --shot (id or shot number) plus `--pano <id>` or `--pano null` for a durable unlink.',
      assetContract: 'Optional single --shot. Omit the flag for the whole project. Multiple ids are rejected. The API remains inspectAssetPoseContract({ shotId? }).',
      generativeWorld: 'Optional --shot/--shots accepts exact ids or production shot numbers. Omitted selects every shot; explicit empty or unknown selection fails.',
      worldDepth: 'Exactly one --shot (id or production shot number), optional --time and WIDTHxHEIGHT --resolution, plus required --output <depth.npy>.',
      package: 'Optional --shot/--shots. Omitted packages every shot. An explicit empty selection is rejected by the export API.',
    },
    artifactRetrieval: {
      renderShotFrame: 'result.handle (pinned artifactId) + result.artifact (inline dataUrl) + result.status',
      renderShotVideo: 'result.artifact.artifactId → downloadArtifact({ artifactId }); download:true is explicit',
      exportPackage: 'result.artifact.artifactId → downloadArtifact({ artifactId })',
      exportProjectBackup: 'window.foreScene.exportProjectBackup({ download: false })',
      transfer: 'CLI download reports transfer.transferMode (chunked-base64 | uint8array-fallback), pageMaterialization (blob-slice | full-uint8array), byteLength, and chunkCount. Browser downloadArtifact is browser-blob (in-memory handle), not a streamed file.',
    },
  };
}
