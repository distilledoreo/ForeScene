/**
 * Shared Agent CLI command inventory for help, discovery, and tests.
 */

export const AGENT_CLI_COMMANDS = [
  'capabilities',
  'describe',
  'schema',
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

export interface AgentCliCommandDescription {
  command: AgentCliCommand;
  operation: string;
  usage: string;
  write?: boolean;
  required: string[];
  optional: string[];
  result: string;
  notes?: string[];
}

const COMMON_SESSION_FLAGS = ['--url <url>', '--headless'] as const;

const COMMAND_DESCRIPTIONS: Partial<Record<AgentCliCommand, AgentCliCommandDescription>> = {
  capabilities: {
    command: 'capabilities', operation: 'agent.capabilities', usage: 'npm run agent:capabilities', write: false,
    required: [], optional: [], result: 'Capability map, operation metadata, command inventory, and JSON envelope contract.',
  },
  describe: {
    command: 'describe', operation: 'agent.describe', usage: 'npm run agent:describe -- --command <cli-command>', write: false,
    required: ['--command <cli-command>'], optional: [], result: 'Machine-readable argv grammar and behavior for one public CLI command.',
  },
  schema: {
    command: 'schema', operation: 'agent.schema', usage: 'npm run agent:schema', write: false,
    required: [], optional: [], result: 'Agent plan limits, executable operations, and result-shape schema document.',
    notes: ['This describes Agent plans/results. Use `describe --command previs` for the production-manifest entry point.'],
  },
  inspect: {
    command: 'inspect', operation: 'project.inspect', usage: 'npm run agent:inspect -- --profile <dir> [--document]', write: false,
    required: ['--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--document'], result: 'Live status, capabilities, project summary, and optional complete document.',
  },
  previs: {
    command: 'previs', operation: 'previs.orchestrate', usage: 'npm run agent:previs -- --manifest <manifest.json> --profile <dir> --output <dir> --write [--reset-project]', write: true,
    required: ['--manifest <manifest.json>', '--profile <isolated-dir>', '--output <dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS, '--reset-project', '--update-manifest', '--initialize-only', '--skip-package', '--no-auto-repair', '--max-repair-passes <n>'],
    result: 'Compiled project, rendered review artifacts, validation, run state, optional control videos, final project, and package status.',
    notes: [
      '`--reset-project` is separately authorized and is prohibited for valuable existing projects.',
      'Manifest reference: docs/previs-production-manifest.md; complete examples: skills/forescene-previs/examples/*.json.',
      'In benchmark mode, omitted manifest/output values are read from FORESCENE_BENCHMARK_BRIEF.',
    ],
  },
  production: {
    command: 'production', operation: 'production.orchestrate', usage: 'npm run agent:production -- --manifest <manifest.json> --profile <dir> --output <dir> --write --mode <rapid-review|delivery>', write: true,
    required: ['--manifest <manifest.json>', '--profile <isolated-dir>', '--output <dir>', '--write'], optional: [...COMMON_SESSION_FLAGS, '--mode <rapid-review|delivery>', '--final-project <project.fsp>', '--reset-project', '--max-repair-passes <n>'],
    result: 'Production orchestration status, review artifacts, validation, and final project path.',
  },
  frame: {
    command: 'frame', operation: 'render.frame', usage: 'npm run agent:frame -- --shot <id-or-number> --mode <clay|projected|depth> --output <frame.png> --profile <dir>', write: false,
    required: ['--shot <id-or-number>', '--output <frame.png>', '--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--mode <clay|projected|depth>', '--time <seconds>', '--people-variant <value>', '--content <value>'], result: 'Canonical PNG, pixel statistics, pose telemetry, artifact handle, and provenance.',
  },
  video: {
    command: 'video', operation: 'render.video', usage: 'npm run agent:video -- --shot <id-or-number> --mode <clay|projected|depth> --output <video.mp4> --profile <dir> --write', write: true,
    required: ['--shot <id-or-number>', '--output <video.mp4>', '--profile <isolated-dir>', '--write'], optional: [...COMMON_SESSION_FLAGS, '--mode <clay|projected|depth>', '--resolution <preset>'], result: 'MP4 artifact, duration, dimensions, transfer, timing, diagnostics, and provenance.',
    notes: ['The selected shot must contain at least two timeline keyframes.'],
  },
  'contact-sheet': {
    command: 'contact-sheet', operation: 'render.contactSheet', usage: 'npm run agent:contact-sheet -- --input <frames-dir> --output <contact-sheet.png>', write: false,
    required: ['--input <frames-dir>', '--output <contact-sheet.png>'], optional: [], result: 'Contact-sheet path.',
  },
  save: {
    command: 'save', operation: 'project.save', usage: 'npm run agent:save -- --output <project.fsp> --profile <dir> --write', write: true,
    required: ['--output <project.fsp>', '--profile <isolated-dir>', '--write'], optional: [...COMMON_SESSION_FLAGS], result: 'Verified FSP backup and transfer telemetry.',
  },
  package: {
    command: 'package', operation: 'export.package', usage: 'npm run agent:package -- --output <package.zip> --profile <dir> --write [--shots <ids>]', write: true,
    required: ['--output <package.zip>', '--profile <isolated-dir>', '--write'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>', '--shots <comma-separated-ids>'], result: 'ZIP package, manifest paths, shot ids, recovery diagnostics, timing, and provenance.',
  },
  'verify-package': {
    command: 'verify-package', operation: 'export.verifyPackage', usage: 'npm run agent:verify-package -- --plan <deliverables-plan.json> --package <package.zip>', write: false,
    required: ['--plan <deliverables-plan.json>', '--package <package.zip>'], optional: [], result: 'Package verification against the supplied deliverables plan.',
  },
};

export function describeAgentCliCommand(command: string): AgentCliCommandDescription | undefined {
  if (!isAgentCliCommand(command)) return undefined;
  return COMMAND_DESCRIPTIONS[command] ?? {
    command,
    operation: `cli.${command}`,
    usage: `npm run agent:${command}`,
    required: [],
    optional: ['Run this command with --help for its public descriptor.'],
    result: 'One stable Agent CLI JSON envelope.',
    notes: ['Consult `agent:capabilities` for write and profile requirements when this compact descriptor omits them.'],
  };
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
      describeCommand: '`npm run agent:describe -- --command <name>` or `npm run agent:<name> -- --help`',
      agentSchema: '`npm run agent:schema` — plan limits, executable operations, and result shapes; no browser required',
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
