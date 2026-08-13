/**
 * Agent CLI argument parser. Extracted so shot-selection contracts can be
 * tested without opening a browser.
 */

import {
  appendCliShotFlag,
  emptyCliShotSelection,
  type CliShotSelection,
} from './cliShotSelection';

export interface AgentCliArgs {
  command: string;
  plan?: string;
  manifest?: string;
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  resetProject: boolean;
  updateManifest: boolean;
  initializeOnly: boolean;
  skipPackage: boolean;
  workspace?: string;
  output?: string;
  packagePath?: string;
  screenshot?: string;
  input?: string;
  file?: string;
  rigPackage?: string;
  proxy?: string;
  replacement?: string;
  mapping?: string;
  rigMode: 'preserve' | 'autorig' | 'auto' | 'saved-rig';
  name?: string;
  consentToken?: string;
  profile?: string;
  shotSelection: CliShotSelection;
  timeSeconds?: number;
  resolution?: string;
  appearance?: string;
  content?: string;
  noAttach: boolean;
  noDownload: boolean;
  allowHeavyCharacterImports: boolean;
  allowHeavyModelImports: boolean;
  batch?: string;
  approveBatch?: string;
  review?: string;
  retryBatch?: string;
  rollbackBatch?: string;
  finalize: boolean;
  operation?: string;
  json: boolean;
  document: boolean;
  peopleVariant?: string;
  mode?: string;
  autoRepair: boolean;
  noAutoRepair: boolean;
  maxRepairPasses?: number;
  timeBudgetSeconds?: number;
}

export function parseAgentCliArgs(argv: string[]): AgentCliArgs {
  const args: AgentCliArgs = {
    command: argv[0] ?? 'inspect',
    headless: false,
    writeAccess: false,
    persistWrite: false,
    resetProject: false,
    updateManifest: false,
    initializeOnly: false,
    skipPackage: false,
    rigMode: 'preserve',
    shotSelection: emptyCliShotSelection(),
    noAttach: false,
    noDownload: false,
    allowHeavyCharacterImports: false,
    allowHeavyModelImports: false,
    finalize: false,
    json: false,
    document: false,
    autoRepair: true,
    noAutoRepair: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--plan') {
      args.plan = argv[++index];
    } else if (token === '--manifest') {
      args.manifest = argv[++index];
    } else if (token === '--url') {
      args.url = argv[++index];
    } else if (token === '--headless') {
      args.headless = true;
    } else if (token === '--write') {
      args.writeAccess = true;
    } else if (token === '--persist-write') {
      args.persistWrite = true;
      args.writeAccess = true;
    } else if (token === '--reset-project') {
      args.resetProject = true;
    } else if (token === '--update-manifest') {
      args.updateManifest = true;
    } else if (token === '--allow-heavy-character-imports') {
      args.allowHeavyCharacterImports = true;
    } else if (token === '--allow-heavy-imports') {
      args.allowHeavyModelImports = true;
    } else if (token === '--initialize-only') {
      args.initializeOnly = true;
    } else if (token === '--skip-package') {
      args.skipPackage = true;
    } else if (token === '--workspace') {
      args.workspace = argv[++index];
    } else if (token === '--output') {
      args.output = argv[++index];
    } else if (token === '--package') {
      args.packagePath = argv[++index];
    } else if (token === '--screenshot') {
      args.screenshot = argv[++index];
    } else if (token === '--input') {
      args.input = argv[++index];
    } else if (token === '--file') {
      args.file = argv[++index];
    } else if (token === '--rig-package') {
      args.rigPackage = argv[++index];
    } else if (token === '--proxy') {
      args.proxy = argv[++index];
    } else if (token === '--replacement') {
      args.replacement = argv[++index];
    } else if (token === '--mapping') {
      args.mapping = argv[++index];
    } else if (token === '--rig-mode') {
      const mode = argv[++index];
      if (mode !== 'preserve' && mode !== 'autorig' && mode !== 'auto' && mode !== 'saved-rig') {
        throw new Error('--rig-mode must be preserve, autorig, auto, or saved-rig');
      }
      args.rigMode = mode;
    } else if (token === '--name') {
      args.name = argv[++index];
    } else if (token === '--consent-token') {
      args.consentToken = argv[++index];
    } else if (token === '--profile') {
      args.profile = argv[++index];
    } else if (token === '--batch') {
      args.batch = argv[++index];
    } else if (token === '--approve') {
      args.approveBatch = argv[++index];
    } else if (token === '--review') {
      args.review = argv[++index];
    } else if (token === '--retry') {
      args.retryBatch = argv[++index];
    } else if (token === '--rollback') {
      args.rollbackBatch = argv[++index];
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--operation') {
      args.operation = argv[++index];
    } else if (token === '--document') {
      args.document = true;
    } else if (token === '--people-variant') {
      args.peopleVariant = argv[++index];
    } else if (token === '--finalize') {
      args.finalize = true;
    } else if (token === '--shot' || token === '--shots') {
      args.shotSelection = appendCliShotFlag(args.shotSelection, token, argv[++index]);
    } else if (token === '--time') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value)) throw new Error('--time must be a finite number');
      args.timeSeconds = value;
    } else if (token === '--resolution') {
      args.resolution = argv[++index];
    } else if (token === '--appearance') {
      args.appearance = argv[++index];
    } else if (token === '--content') {
      args.content = argv[++index];
    } else if (token === '--no-attach') {
      args.noAttach = true;
    } else if (token === '--no-download') {
      args.noDownload = true;
    } else if (token === '--mode') {
      args.mode = argv[++index];
    } else if (token === '--no-auto-repair') {
      args.noAutoRepair = true;
      args.autoRepair = false;
    } else if (token === '--max-repair-passes') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--max-repair-passes must be a non-negative number');
      }
      args.maxRepairPasses = value;
    } else if (token === '--time-budget') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--time-budget must be a positive number');
      }
      args.timeBudgetSeconds = value;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown flag: ${token}`);
    }
  }

  return args;
}
