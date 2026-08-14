/**
 * Machine-readable Agent CLI capability catalog.
 *
 * This is the public automation surface. Agents should query
 * `npm run agent:capabilities` instead of inspecting ForeScene source.
 */

import { AGENT_CLI_COMMANDS, type AgentCliCommand } from './cliCommands';

export const AGENT_CLI_CAPABILITY_SCHEMA_VERSION = 1 as const;

export const AGENT_RENDER_APPEARANCES = ['clay', 'projected', 'depth'] as const;
export type AgentRenderAppearance = (typeof AGENT_RENDER_APPEARANCES)[number];

export function isAgentRenderAppearance(value: string | undefined): value is AgentRenderAppearance {
  return value === 'clay' || value === 'projected' || value === 'depth';
}

export function resolveAgentRenderAppearance(input: {
  command: string;
  appearance?: string;
  mode?: string;
}): AgentRenderAppearance {
  if (input.appearance) {
    if (!isAgentRenderAppearance(input.appearance)) {
      throw new Error(
        `${input.command} --appearance must be clay, projected, or depth. Received ${input.appearance}.`,
      );
    }
    return input.appearance;
  }
  if (input.mode) {
    if (!isAgentRenderAppearance(input.mode)) {
      throw new Error(
        `${input.command} --mode must be clay, projected, or depth. Received ${input.mode}.`,
      );
    }
    return input.mode;
  }
  return 'clay';
}

export interface AgentCliCapabilityRecord {
  id: string;
  label: string;
  cliCommand: AgentCliCommand | null;
  cli: boolean;
  ui: boolean;
  agentApi: boolean;
  skillDocumented: boolean;
  stable: boolean;
  write: boolean;
  notes?: string;
}

export const AGENT_CLI_CAPABILITY_RECORDS: AgentCliCapabilityRecord[] = [
  {
    id: 'agent.capabilities',
    label: 'Discover CLI capabilities',
    cliCommand: 'capabilities',
    cli: true,
    ui: false,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'project.inspect',
    label: 'Inspect project',
    cliCommand: 'inspect',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'project.open',
    label: 'Open .fsp / project package',
    cliCommand: 'open',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
    notes: 'npm run agent:open -- --file <package.fsp> --write',
  },
  {
    id: 'project.save',
    label: 'Save / export project backup',
    cliCommand: 'save',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
    notes: 'npm run agent:save -- --output <package.fsp> --write',
  },
  {
    id: 'operation.cancel',
    label: 'Cancel a running CLI operation',
    cliCommand: 'cancel',
    cli: true,
    ui: false,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
    notes: 'npm run agent:cancel -- --operation <op_id> sends SIGINT to the CLI pid; it does not kill Chromium.',
  },
  {
    id: 'operation.list',
    label: 'List CLI operations',
    cliCommand: 'operations',
    cli: true,
    ui: false,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'project.previewPlan',
    label: 'Preview mutation plan',
    cliCommand: 'preview',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'project.applyPlan',
    label: 'Apply plan',
    cliCommand: 'apply',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'character.analyze',
    label: 'Analyze character',
    cliCommand: 'analyze-character',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'character.import',
    label: 'Import GLB character',
    cliCommand: 'import-character',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'character.importSavedRig',
    label: 'Import .fsrig saved rig',
    cliCommand: 'import-character',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
    notes: '--rig-mode saved-rig --rig-package <file.fsrig>',
  },
  {
    id: 'model.import',
    label: 'Import GLB / scene model',
    cliCommand: 'import-model',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'panorama.import',
    label: 'Import styled panorama',
    cliCommand: 'import-panorama',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'shot.setPanorama',
    label: 'Link or unlink a shot panorama',
    cliCommand: 'shot-panorama',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
    notes: '--shot <id-or-number> --pano <id|null>',
  },
  {
    id: 'proxy.replace',
    label: 'Replace proxy with imported model',
    cliCommand: 'replace-proxy',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'render.frame.clay',
    label: 'Render clay frame',
    cliCommand: 'frame',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
    notes: '--mode clay (default)',
  },
  {
    id: 'render.frame.projected',
    label: 'Render projected frame',
    cliCommand: 'frame',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
    notes: '--mode projected or --appearance projected',
  },
  {
    id: 'render.frame.depth',
    label: 'Render depth frame',
    cliCommand: 'frame',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
    notes: '--mode depth',
  },
  {
    id: 'render.video.clay',
    label: 'Render clay video',
    cliCommand: 'video',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'render.video.projected',
    label: 'Render projected video',
    cliCommand: 'video',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
    notes: '--appearance projected or --mode projected',
  },
  {
    id: 'render.video.depth',
    label: 'Render depth video',
    cliCommand: 'video',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'render.passes',
    label: 'Render review pass matrix',
    cliCommand: 'render-passes',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'render.stills',
    label: 'Render stills batch',
    cliCommand: 'render-stills',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'render.contactSheet',
    label: 'Build contact sheet',
    cliCommand: 'contact-sheet',
    cli: true,
    ui: true,
    agentApi: false,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'screenshot.viewport',
    label: 'Capture UI screenshot',
    cliCommand: 'screenshot',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'export.plan',
    label: 'Plan export deliverables',
    cliCommand: 'plan-exports',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'export.package',
    label: 'Export package',
    cliCommand: 'package',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'export.verifyPackage',
    label: 'Verify export package',
    cliCommand: 'verify-package',
    cli: true,
    ui: false,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'verify.visualPreflight',
    label: 'Visual preflight',
    cliCommand: 'visual-preflight',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'verify.assetContract',
    label: 'Asset pose contract',
    cliCommand: 'asset-contract',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'verify.project',
    label: 'Verify project health',
    cliCommand: 'verify',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: false,
  },
  {
    id: 'previs.orchestrate',
    label: 'Greenfield previs orchestration',
    cliCommand: 'previs',
    cli: true,
    ui: false,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'production.orchestrate',
    label: 'Gated production runner',
    cliCommand: 'production',
    cli: true,
    ui: true,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'pipeline.run',
    label: 'Preview + apply + screenshot',
    cliCommand: 'run',
    cli: true,
    ui: false,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
  },
  {
    id: 'refine.existingProject',
    label: 'Optional existing-project refinement runner',
    cliCommand: 'refine',
    cli: true,
    ui: false,
    agentApi: true,
    skillDocumented: true,
    stable: true,
    write: true,
    notes: 'Advanced runner; not required for ordinary operation.',
  },
];

export function buildAgentCliCapabilityMap(): Record<string, boolean> {
  return Object.fromEntries(AGENT_CLI_CAPABILITY_RECORDS.map((record) => [record.id, record.cli]));
}

export function buildAgentCliCapabilitiesDocument() {
  return {
    schemaVersion: AGENT_CLI_CAPABILITY_SCHEMA_VERSION,
    surface: 'cli' as const,
    canonical: true,
    capabilities: buildAgentCliCapabilityMap(),
    operations: Object.fromEntries(AGENT_CLI_CAPABILITY_RECORDS.map((record) => [record.id, {
      cli: record.cli,
      ui: record.ui,
      agentApi: record.agentApi,
      skillDocumented: record.skillDocumented,
      stable: record.stable,
      write: record.write,
      command: record.cliCommand,
      notes: record.notes,
    }])),
    commands: [...AGENT_CLI_COMMANDS],
    renderAppearances: [...AGENT_RENDER_APPEARANCES],
    jsonContract: {
      envelope: ['ok', 'operation', 'operationId', 'durationMs', 'projectId', 'revisionId', 'affectedObjectIds', 'affectedShotIds', 'warnings', 'error', 'profileRecovery', 'result'],
      exitCodes: { success: 0, failure: 1, usage: 2 },
    },
  };
}

export function commandToOperationName(command: string): string {
  if (command === 'help') return 'agent.help';
  if (command === 'frame') return 'render.frame';
  if (command === 'video') return 'render.video';
  if (command === 'cancel') return 'operation.cancel';
  if (command === 'operations') return 'operation.list';
  const match = AGENT_CLI_CAPABILITY_RECORDS.find((record) => record.cliCommand === command);
  return match?.id ?? `cli.${command}`;
}

export function renderCapabilityMatrixMarkdown(): string {
  const rows = AGENT_CLI_CAPABILITY_RECORDS.map((record) => {
    const mark = (value: boolean) => (value ? '✅' : '❌');
    return `| ${record.label} | \`${record.id}\` | ${mark(record.ui)} | ${mark(record.agentApi)} | ${mark(record.cli)} | ${mark(record.skillDocumented)} | ${mark(record.stable)} |`;
  }).join('\n');
  return `# ForeScene Agent capability matrix

The **CLI is the canonical public automation surface**. Agents operating ForeScene
should use documented \`npm run agent:*\` commands. Do not inspect ForeScene source
or call \`window.foreScene\` for an operation this matrix marks as CLI-supported.

Query the live catalog without opening a browser:

\`\`\`bash
npm run agent:capabilities
\`\`\`

Stdout is a stable JSON envelope. \`result.capabilities\` is the compact boolean map:

\`\`\`json
{
  "project.open": true,
  "project.save": true,
  "character.importSavedRig": true,
  "render.frame.projected": true,
  "render.video.projected": true
}
\`\`\`

If a capability is \`true\`, use the documented command. Do not inspect its
implementation.

## Matrix

| Capability | Id | UI | Agent API | CLI | Skill documented | Stable |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## Rendering abstraction

Clay, projected, and depth are modes of one frame/video command:

\`\`\`bash
npm run agent:frame -- --shot 01 --mode clay --output artifacts/01.clay.png
npm run agent:frame -- --shot 01 --mode projected --output artifacts/01.projected.png
npm run agent:frame -- --shot 01 --mode depth --output artifacts/01.depth.png
npm run agent:video -- --shot 03 --mode projected --write --output artifacts/03.mp4
\`\`\`

\`--appearance\` remains a supported alias of \`--mode\` for render commands.

## Project open and save

\`\`\`bash
npm run agent:open -- --file path/to/project.fsp --write
npm run agent:save -- --output artifacts/project.fsp --write
\`\`\`

Open and save require \`--write\` or \`--persist-write\` because they replace or
export the live project through the protected Agent API.

## JSON contract

Every CLI command writes one JSON object to stdout:

| Field | Meaning |
| --- | --- |
| \`ok\` | Explicit success or failure |
| \`operation\` | Stable capability / operation name |
| \`durationMs\` | Wall time for this invocation |
| \`projectId\` / \`revisionId\` | Affected project identity when known |
| \`affectedObjectIds\` / \`affectedShotIds\` | Affected entities when known |
| \`warnings\` | Non-fatal diagnostics |
| \`error\` | \`{ code, message }\` on failure |
| \`result\` | Command-specific payload |

Exit codes: \`0\` success, \`1\` operation failure, \`2\` usage / argument error.

Human progress remains on stderr and is not part of the machine contract.
`;
}
