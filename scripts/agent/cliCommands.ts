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

const COMMAND_DESCRIPTIONS: Record<AgentCliCommand, AgentCliCommandDescription> = {
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
    optional: [...COMMON_SESSION_FLAGS, '--reset-project', '--update-manifest', '--initialize-only', '--skip-package', '--no-auto-repair', '--max-repair-passes <n>', '--time-budget <seconds>', '--prune-non-manifest-shots'],
    result: 'Compiled project, rendered review artifacts, validation, run state, optional control videos, final project, and package status.',
    notes: [
      '`--reset-project` is separately authorized and is prohibited for valuable existing projects.',
      '`--no-auto-repair` disables the repair loop entirely; the summary reports repairsDisabled:true and repairsAttempted:0.',
      'After shot compilation the runner prunes intact scaffold shots (for example the blank Origin shot) that are not in the manifest. Non-manifest user shots are retained and reported unless `--prune-non-manifest-shots` is passed.',
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
    command: 'contact-sheet', operation: 'render.contactSheet', usage: 'npm run agent:contact-sheet -- --input <frames-dir> --output <contact-sheet.png> [--allow-partial]', write: false,
    required: ['--input <frames-dir>', '--output <contact-sheet.png>'], optional: ['--allow-partial'],
    result: 'Contact-sheet path plus a per-shot frame report (existence, run-state render status, sha256).',
    notes: [
      'Fails closed: a missing or empty frame, or a run-state shot that did not render, returns ok:false with per-shot diagnostics and no sheet.',
      '--allow-partial builds the sheet over the frames that do exist so operators can inspect partial output; ok stays false and partial:true is reported.',
    ],
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
  open: {
    command: 'open', operation: 'project.open', usage: 'npm run agent:open -- --file <project.fsp> --profile <dir> --write', write: true,
    required: ['--file <project.fsp>', '--profile <isolated-dir>', '--write'], optional: [...COMMON_SESSION_FLAGS],
    result: 'openProjectPackage result: loaded project identity, preservation summary, shots/assets counts, and diagnostics.',
    notes: ['The package is staged through the app file input and opened in-browser; --write makes the opened project the live project.'],
  },
  cancel: {
    command: 'cancel', operation: 'operation.cancel', usage: 'npm run agent:cancel [-- --operation <id>]', write: false,
    required: [], optional: ['--operation <id> (omit to cancel the latest active run)'],
    result: 'Cancel acknowledgement for the targeted CLI operation record.',
    notes: ['Stateless: no browser or profile required.'],
  },
  operations: {
    command: 'operations', operation: 'operation.list', usage: 'npm run agent:operations', write: false,
    required: [], optional: [],
    result: 'Every persisted CLI operation record plus the active subset.',
    notes: ['Stateless: no browser or profile required.'],
  },
  preview: {
    command: 'preview', operation: 'project.previewPlan', usage: 'npm run agent:preview -- --plan <plan.json> --profile <dir>', write: false,
    required: ['--plan <plan.json>', '--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS],
    result: 'Prepared plan diff (summary, warnings, per-command results) without mutating the live project.',
    notes: ['Read-only: preview does not require --write.'],
  },
  apply: {
    command: 'apply', operation: 'project.applyPlan', usage: 'npm run agent:apply -- --plan <plan.json> --profile <dir> --write [--expected-revision <id>]', write: true,
    required: ['--plan <plan.json>', '--profile <isolated-dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS, '--expected-revision <revision-id>'],
    result: 'Atomic plan apply result: summary, affected ids, verified revision, and diagnostics.',
    notes: [
      '--expected-revision is compare-and-swap: the apply refuses with stale_revision when the live verified revision differs.',
    ],
  },
  screenshot: {
    command: 'screenshot', operation: 'screenshot.viewport', usage: 'npm run agent:screenshot -- --output <screenshot.png> --profile <dir> [--workspace <build|shots>]', write: false,
    required: ['--output <screenshot.png>', '--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--workspace <build|shots>'],
    result: 'Viewport screenshot path plus live status.',
  },
  verify: {
    command: 'verify', operation: 'verify.project', usage: 'npm run agent:verify -- --profile <dir> [--shot <ids>] [--output <screenshot.png>]', write: false,
    required: ['--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>', '--shots <comma-separated-ids>', '--workspace <build|shots>', '--output <screenshot.png>'],
    result: 'Visual preflight, asset pose contract, project health, provenance, and optional screenshot.',
    notes: ['Omitted --shot/--shots validates every shot; unknown explicit selections fail visual validation and unmatched ids appear in the JSON result and provenance.'],
  },
  'visual-preflight': {
    command: 'visual-preflight', operation: 'verify.visualPreflight', usage: 'npm run agent:visual-preflight -- --profile <dir> [--shot <ids>]', write: false,
    required: ['--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>', '--shots <comma-separated-ids>'],
    result: 'Per-shot visual preflight results, unmatched ids, and recorded validation evidence.',
    notes: ['Same --shot/--shots contract as verify.'],
  },
  'asset-contract': {
    command: 'asset-contract', operation: 'verify.assetContract', usage: 'npm run agent:asset-contract -- --profile <dir> [--shot <id-or-number>]', write: false,
    required: ['--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>'],
    result: 'Asset pose contract for one shot or the whole project plus provenance.',
    notes: ['Optional single --shot; omit the flag for the whole project. Multiple ids are rejected. Selectors resolve to the canonical API shotId.'],
  },
  'world-preview': {
    command: 'world-preview', operation: 'world.request.preview', usage: 'npm run agent:world-preview -- --profile <dir> [--shot <ids>] [--output <request.json>]', write: false,
    required: ['--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>', '--shots <comma-separated-ids>', '--output <request.json>'],
    result: 'Backend-neutral generative-world request plus HY-World 2 camera-prior JSON for the selected shots.',
  },
  'world-mock': {
    command: 'world-mock', operation: 'world.backend.mockRun', usage: 'npm run agent:world-mock -- --profile <dir> [--shot <ids>] [--output <result.json>]', write: false,
    required: ['--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>', '--shots <comma-separated-ids>', '--output <result.json>'],
    result: 'Deterministic generative-world backend mock run for the selected shots; no external inference.',
  },
  'world-depth': {
    command: 'world-depth', operation: 'world.depth.render', usage: 'npm run agent:world-depth -- --shot <id-or-number> --output <depth.npy> --profile <dir>', write: false,
    required: ['--shot <id-or-number>', '--output <depth.npy>', '--profile <isolated-dir>'],
    optional: [...COMMON_SESSION_FLAGS, '--time <seconds>', '--resolution <WIDTHxHEIGHT>'],
    result: 'Raw float32 camera-Z depth prior (.npy) artifact, transfer telemetry, and provenance.',
  },
  run: {
    command: 'run', operation: 'pipeline.run', usage: 'npm run agent:run -- --plan <plan.json> --profile <dir> --write [--screenshot <png>]', write: true,
    required: ['--plan <plan.json>', '--profile <isolated-dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS, '--screenshot <screenshot.png> (alias --output)', '--workspace <build|shots>'],
    result: 'Plan apply followed by a viewport screenshot in one operation.',
  },
  'render-stills': {
    command: 'render-stills', operation: 'render.stills', usage: 'npm run agent:render-stills -- --profile <dir> --write [--output <dir>]', write: true,
    required: ['--profile <isolated-dir>', '--write'], optional: [...COMMON_SESSION_FLAGS, '--output <dir> (default artifacts/previs)'],
    result: 'Per-shot still render counts with failedShotNumbers and pendingShotNumbers; ok is false when any compiled shot is unrendered or failed.',
    notes: [
      'Resumes from run-state.json written by agent:previs; run previs first.',
      'ok is a conjunction: a batch with one failed or stale shot reports ok:false with per-shot details.',
    ],
  },
  'render-passes': {
    command: 'render-passes', operation: 'render.passes', usage: 'npm run agent:render-passes -- --output <dir> --profile <dir> [--shots <ids>]', write: false,
    required: ['--output <directory>', '--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>', '--shots <comma-separated-ids>'],
    result: 'Six-pass review matrix (clay/projected × with-people/clean-plate, characters-only, depth) per shot with sha256 per file and uniqueness verification.',
  },
  'plan-exports': {
    command: 'plan-exports', operation: 'export.plan', usage: 'npm run agent:plan-exports -- --output <deliverables-plan.json> --profile <dir> [--shots <ids>]', write: false,
    required: ['--output <deliverables-plan.json>', '--profile <isolated-dir>'], optional: [...COMMON_SESSION_FLAGS, '--shot <id-or-number>', '--shots <comma-separated-ids>'],
    result: 'Deliverables export plan for verify-package, scoped to the selected shots (all shots when omitted).',
  },
  refine: {
    command: 'refine', operation: 'refine.existingProject', usage: 'npm run agent:refine -- --plan <refinement-plan.json> --output <dir> --profile <dir> --write [--batch <id>]', write: true,
    required: ['--plan <refinement-plan.json>', '--output <directory>', '--profile <isolated-dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS, '--batch <batch-id>', '--approve <batch-id>', '--review <review.json>', '--retry <batch-id>', '--rollback <batch-id>', '--finalize', '--allow-heavy-character-imports', '--allow-heavy-imports'],
    result: 'Resumable refinement run state: batches, review evidence, checkpoints, and awaiting_visual_review gating.',
    notes: ['Optional advanced runner for high-risk modification of a valuable existing project; not required for ordinary operation.'],
  },
  'analyze-character': {
    command: 'analyze-character', operation: 'character.analyze', usage: 'npm run agent:analyze-character -- --file <character.glb> --profile <dir>', write: false,
    required: ['--file <character.glb|fbx>', '--profile <isolated-dir>'],
    optional: [...COMMON_SESSION_FLAGS, '--rig-mode <preserve|autorig|auto|saved-rig>', '--rig-package <path.fsrig>', '--output <analysis.json>'],
    result: 'Character import analysis: skeleton, skinning, mapping confidence, and saved-rig compatibility diagnostics.',
    notes: ['--rig-mode saved-rig requires --rig-package.'],
  },
  'import-character': {
    command: 'import-character', operation: 'character.import', usage: 'npm run agent:import-character -- --file <character.glb> --profile <dir> --write', write: true,
    required: ['--file <character.glb|fbx>', '--profile <isolated-dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS, '--rig-mode <preserve|autorig|auto|saved-rig>', '--rig-package <path.fsrig>', '--name <name>', '--mapping <overrides.json>', '--consent-token <token>', '--allow-heavy-character-imports', '--output <result.json>'],
    result: 'Imported poseable character id, applied pose preset report, and diagnostics.',
    notes: ['--rig-mode saved-rig requires --rig-package. Heavy imports require --allow-heavy-character-imports or --consent-token.'],
  },
  'import-model': {
    command: 'import-model', operation: 'model.import', usage: 'npm run agent:import-model -- --file <model.glb> --profile <dir> --write', write: true,
    required: ['--file <model.glb>', '--profile <isolated-dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS, '--allow-heavy-imports', '--consent-token <token>', '--output <result.json>'],
    result: 'Imported scene model object id, bounds, and diagnostics.',
    notes: ['Imports in separate-objects mode; heavy imports require --allow-heavy-imports or --consent-token.'],
  },
  'import-panorama': {
    command: 'import-panorama', operation: 'panorama.import', usage: 'npm run agent:import-panorama -- --file <pano.jpg> --profile <dir> --write', write: true,
    required: ['--file <panorama.jpg|png>', '--profile <isolated-dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS, '--name <name>'],
    result: 'Imported panorama reference id and canonical prepared-media status.',
  },
  'shot-panorama': {
    command: 'shot-panorama', operation: 'shot.setPanorama', usage: 'npm run agent:shot-panorama -- --shot <id-or-number> --pano <pano-id|null> --profile <dir> --write', write: true,
    required: ['--shot <id-or-number>', '--pano <pano-id|null>', '--profile <isolated-dir>', '--write'], optional: [...COMMON_SESSION_FLAGS],
    result: 'Durable shot→panorama link or unlink result with the resolved canonical shotId.',
    notes: ['--pano null (or empty) unlinks durably.'],
  },
  'replace-proxy': {
    command: 'replace-proxy', operation: 'proxy.replace', usage: 'npm run agent:replace-proxy -- --proxy <object-id> --replacement <object-id> --shots <ids> --output <report.json> --profile <dir> --write', write: true,
    required: ['--proxy <object-id>', '--replacement <object-id>', '--shots <comma-separated-ids>', '--output <report.json>', '--profile <isolated-dir>', '--write'],
    optional: [...COMMON_SESSION_FLAGS],
    result: 'Verified proxy replacement report: before/after staging evidence, preserved ids, render frames, and verification diagnostics.',
  },
  help: {
    command: 'help', operation: 'agent.help', usage: 'npm run agent:help [-- --json]', write: false,
    required: [], optional: ['--json'],
    result: 'Command inventory plus the shared checks/discovery document (machine-readable with --json).',
    notes: ['Stateless: no browser or profile required.'],
  },
};

/**
 * Fail-closed discovery: COMMAND_DESCRIPTIONS is exhaustive (Record), so every
 * public CLI command has a real descriptor. A command without a descriptor is
 * not a public command; this returns undefined only for unknown commands.
 */
export function describeAgentCliCommand(command: string): AgentCliCommandDescription | undefined {
  if (!isAgentCliCommand(command)) return undefined;
  return COMMAND_DESCRIPTIONS[command];
}

export function buildAgentCliHelpDocument() {
  return {
    commands: [...AGENT_CLI_COMMANDS],
    checks: {
      visualPreflight: 'collectVisualPreflightValidation via `visual-preflight` or `verify`. Omitted --shots validates every shot. Explicit --shot/--shots is passed through; unknown or empty explicit selection fails, and unmatched ids appear in the JSON result and provenance. visualPreflight: [] is never a passed gate. Empty projects omit the visual gate (skipped).',
      assetPoseContract: 'inspectAssetPoseContract via `asset-contract` or `verify`. `asset-contract` accepts one optional --shot (id or shot number, resolved to the canonical API shotId); omit the flag for the whole project. Multiple ids are rejected.',
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
      resolver: 'Every --shot/--shots selector accepts canonical shot ids or shot numbers; "010", "10", and "0010" address the same shot. Selectors resolve once at the CLI boundary, ambiguity fails closed with candidate ids, and render results echo shotId + shotNumber.',
      verify: 'Optional --shot/--shots. Omitted validates every shot (empty projects skip the visual gate). Selectors that match resolve to canonical ids; unknown ids pass through to the engine, fail collectVisualPreflightValidation, and appear in the JSON result and provenance.',
      visualPreflight: 'Same --shot/--shots contract as verify.',
      frame: 'Exactly one --shot (or a single --shots value). Additional ids are rejected before the browser opens. The selector resolves to the canonical shot id before rendering.',
      video: 'Exactly one --shot (or a single --shots value). Additional ids are rejected before the browser opens. The selector resolves to the canonical shot id before rendering.',
      shotPanorama: 'Exactly one --shot (id or shot number) plus `--pano <id>` or `--pano null` for a durable unlink.',
      assetContract: 'Optional single --shot. Omit the flag for the whole project. Multiple ids are rejected. Selectors resolve to the canonical API shotId.',
      generativeWorld: 'Optional --shot/--shots accepts ids or shot numbers (leading zeros normalized). Omitted selects every shot; explicit empty or unknown selection fails.',
      worldDepth: 'Exactly one --shot (id or shot number), optional --time and WIDTHxHEIGHT --resolution, plus required --output <depth.npy>.',
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
