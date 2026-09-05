import type { AgentCliEnvelope } from '../agent/cliResult';

export interface InspectSnapshot {
  projectId: string;
  shotIds: string[];
  castCount: number;
  assetCount: number;
  importedModelCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function castObjectTypes(): Set<string> {
  return new Set(['human_dummy', 'poseable_character']);
}

export function inspectSnapshotFromInspectPayload(payload: unknown): InspectSnapshot | undefined {
  if (!isRecord(payload)) return undefined;
  const project = isRecord(payload.project) ? payload.project : undefined;
  const projectId = asString(project?.id);
  if (!projectId) return undefined;

  const shots = Array.isArray(payload.shots) ? payload.shots : [];
  const shotIds = shots
    .map((shot) => (isRecord(shot) ? asString(shot.id) : undefined))
    .filter((id): id is string => Boolean(id));

  const objects = Array.isArray(payload.objects) ? payload.objects : [];
  const castTypes = castObjectTypes();
  const castCount = objects.filter((entry) => (
    isRecord(entry) && typeof entry.type === 'string' && castTypes.has(entry.type)
  )).length;

  const document = isRecord(payload.document) ? payload.document : undefined;
  const documentAssets = isRecord(document?.assets) && isRecord(document.assets.assets)
    ? Object.keys(document.assets.assets).length
    : undefined;
  const modelAssetIds = new Set(
    objects
      .map((entry) => (isRecord(entry) ? asString(entry.modelAssetId) : undefined))
      .filter((id): id is string => Boolean(id)),
  );
  const importedModelCount = objects.filter((entry) => (
    isRecord(entry) && entry.type === 'imported_model'
  )).length;
  const assetCount = documentAssets ?? modelAssetIds.size;

  return { projectId, shotIds, castCount, assetCount, importedModelCount };
}

export function inspectSnapshotFromEnvelope(envelope: AgentCliEnvelope): InspectSnapshot | undefined {
  return inspectSnapshotFromInspectPayload(envelope.result);
}

export function capabilitiesExportPackage(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const nested = isRecord(payload.result) ? payload.result : payload;
  const capabilities = isRecord(nested.capabilities) ? nested.capabilities : undefined;
  if (capabilities && typeof capabilities['export.package'] === 'boolean') {
    return capabilities['export.package'];
  }
  const operations = isRecord(nested.operations) ? nested.operations : undefined;
  const operation = operations?.['export.package'];
  if (isRecord(operation) && typeof operation.cli === 'boolean') return operation.cli;
  return false;
}

export function shotIdSetEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}
