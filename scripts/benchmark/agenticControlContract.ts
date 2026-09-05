import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './layout';

export type AgenticControlFamily =
  | 'lifecycle-control'
  | 'operator-intent'
  | 'import-idempotency'
  | 'fresh-profile-recovery';
export type AgenticControlContractId =
  | 'agentic-control-v1'
  | 'agentic-control-v2'
  | 'agentic-control-v3'
  | 'agentic-control-v4';

const CONTRACT_IDS = new Set<AgenticControlContractId>([
  'agentic-control-v1',
  'agentic-control-v2',
  'agentic-control-v3',
  'agentic-control-v4',
]);
const FAMILIES = new Set<AgenticControlFamily>([
  'lifecycle-control',
  'operator-intent',
  'import-idempotency',
  'fresh-profile-recovery',
]);

interface AgenticControlContractBase {
  version: 1;
  id: AgenticControlContractId;
  family: AgenticControlFamily;
  description: string;
  seedPackage: string;
  artifacts: {
    savedProject: string;
    candidateReport: string;
    packageExport?: string;
    clayFrame?: string;
  };
  thresholds: {
    minBytes: number;
  };
  scoring: {
    requirePackageWhenCapable?: boolean;
    checkRepositoryDrift: boolean;
  };
}

export interface AgenticControlLifecycleContract extends AgenticControlContractBase {
  family: 'lifecycle-control' | 'operator-intent';
  render: {
    shotSelector: 'first';
    mode: 'clay';
    artifact: string;
  };
  scoring: {
    requirePackageWhenCapable: boolean;
    checkRepositoryDrift: boolean;
  };
}

export interface AgenticControlImportContract extends AgenticControlContractBase {
  family: 'import-idempotency';
  importModel: {
    fixtureSource: string;
    runRelativePath: string;
  };
  scoring: {
    checkRepositoryDrift: boolean;
  };
}

export interface AgenticControlFreshProfileContract extends AgenticControlContractBase {
  family: 'fresh-profile-recovery';
  scoring: {
    checkRepositoryDrift: boolean;
  };
}

export type AgenticControlContract =
  | AgenticControlLifecycleContract
  | AgenticControlImportContract
  | AgenticControlFreshProfileContract;

export interface LoadedAgenticControlContract {
  contract: AgenticControlContract;
  contractPath: string;
  seedPath: string;
  importFixturePath?: string;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string.`);
  return value;
}

export function isImportIdempotencyContract(
  contract: AgenticControlContract,
): contract is AgenticControlImportContract {
  return contract.family === 'import-idempotency';
}

export function isFreshProfileRecoveryContract(
  contract: AgenticControlContract,
): contract is AgenticControlFreshProfileContract {
  return contract.family === 'fresh-profile-recovery';
}

function parseContract(value: unknown): AgenticControlContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agentic-control contract must be an object.');
  }
  const record = value as Partial<AgenticControlContract>;
  if (record.version !== 1) throw new Error('agentic-control contract version must be 1.');
  if (!record.id || !CONTRACT_IDS.has(record.id)) {
    throw new Error('agentic-control contract id must be agentic-control-v1, v2, v3, or v4.');
  }
  if (!record.family || !FAMILIES.has(record.family)) {
    throw new Error(
      'agentic-control contract family must be lifecycle-control, operator-intent, import-idempotency, or fresh-profile-recovery.',
    );
  }
  if (!record.artifacts?.savedProject || !record.artifacts?.candidateReport) {
    throw new Error('agentic-control contract requires artifacts.savedProject and artifacts.candidateReport.');
  }

  const base = {
    version: 1 as const,
    id: record.id,
    description: asString(record.description, 'description'),
    seedPackage: asString(record.seedPackage, 'seedPackage'),
    artifacts: {
      savedProject: asString(record.artifacts.savedProject, 'artifacts.savedProject'),
      candidateReport: asString(record.artifacts.candidateReport, 'artifacts.candidateReport'),
      ...(record.artifacts.packageExport
        ? { packageExport: asString(record.artifacts.packageExport, 'artifacts.packageExport') }
        : {}),
      ...(record.artifacts.clayFrame
        ? { clayFrame: asString(record.artifacts.clayFrame, 'artifacts.clayFrame') }
        : {}),
    },
    thresholds: {
      minBytes: typeof record.thresholds?.minBytes === 'number' && record.thresholds.minBytes > 0
        ? record.thresholds.minBytes
        : 1024,
    },
  };

  if (record.family === 'fresh-profile-recovery') {
    return {
      ...base,
      family: 'fresh-profile-recovery',
      scoring: {
        checkRepositoryDrift: record.scoring?.checkRepositoryDrift !== false,
      },
    };
  }

  if (record.family === 'import-idempotency') {
    const importModel = (record as Partial<AgenticControlImportContract>).importModel;
    if (!importModel?.fixtureSource || !importModel.runRelativePath) {
      throw new Error('import-idempotency contract requires importModel.fixtureSource and runRelativePath.');
    }
    return {
      ...base,
      family: 'import-idempotency',
      importModel: {
        fixtureSource: asString(importModel.fixtureSource, 'importModel.fixtureSource'),
        runRelativePath: asString(importModel.runRelativePath, 'importModel.runRelativePath'),
      },
      scoring: {
        checkRepositoryDrift: record.scoring?.checkRepositoryDrift !== false,
      },
    };
  }

  const render = (record as Partial<AgenticControlLifecycleContract>).render;
  if (!render || render.mode !== 'clay') {
    throw new Error('agentic-control contract render.mode must be clay.');
  }
  if (render.shotSelector !== 'first') {
    throw new Error('agentic-control contract render.shotSelector must be first.');
  }
  return {
    ...base,
    family: record.family,
    render: {
      shotSelector: 'first',
      mode: 'clay',
      artifact: asString(render.artifact, 'render.artifact'),
    },
    scoring: {
      requirePackageWhenCapable: record.scoring && 'requirePackageWhenCapable' in record.scoring
        ? record.scoring.requirePackageWhenCapable !== false
        : true,
      checkRepositoryDrift: record.scoring?.checkRepositoryDrift !== false,
    },
  };
}

export async function loadAgenticControlContract(contractPath: string): Promise<LoadedAgenticControlContract> {
  const resolved = path.resolve(contractPath);
  const contract = parseContract(JSON.parse(await readFile(resolved, 'utf8')));
  const seedPath = path.resolve(path.dirname(resolved), contract.seedPackage);
  const importFixturePath = isImportIdempotencyContract(contract)
    ? path.resolve(repoRoot(), contract.importModel.fixtureSource)
    : undefined;
  return { contract, contractPath: resolved, seedPath, importFixturePath };
}

export function resolveAgenticControlRunPath(runRoot: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.includes('..')) {
    throw new Error(`Run artifact paths must be relative to the run root: ${relative}`);
  }
  return path.join(runRoot, relative);
}
