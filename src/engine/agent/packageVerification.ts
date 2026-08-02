import JSZip from 'jszip';
import type { ExportPlan, PlannedArtifact } from '../exportPlan';

export interface MissingPackageArtifact {
  shotId: string;
  artifactId: string;
  kind: PlannedArtifact['kind'];
  path: string;
}

export interface PackageVerificationResult {
  ok: boolean;
  expectedEntryCount: number;
  actualEntryCount: number;
  missing: MissingPackageArtifact[];
}

/** Accept a raw plan or the browser API envelope written by agent:plan-exports. */
export type PackageVerificationPlan = Pick<ExportPlan, 'shots' | 'sharedArtifacts'> | {
  plan?: Pick<ExportPlan, 'shots' | 'sharedArtifacts'>;
};

function resolvePlan(plan: PackageVerificationPlan): Pick<ExportPlan, 'shots' | 'sharedArtifacts'> {
  const candidate = Array.isArray((plan as Partial<ExportPlan>).shots)
    ? plan as Pick<ExportPlan, 'shots' | 'sharedArtifacts'>
    : (plan as { plan?: Pick<ExportPlan, 'shots' | 'sharedArtifacts'> }).plan;
  if (!candidate || !Array.isArray(candidate.shots) || !Array.isArray(candidate.sharedArtifacts)) {
    throw new Error('Export plan must contain shots and sharedArtifacts, or be a successful agent:plan-exports result.');
  }
  return candidate;
}

/**
 * Compare the exact files the shared export planner requested with a produced
 * ZIP. This is intentionally a post-export proof: planner omissions are not
 * treated as expectations, but every `produce` artifact must be present.
 */
export async function verifyPackageAgainstExportPlan(
  plan: PackageVerificationPlan,
  packageData: Blob | ArrayBuffer,
): Promise<PackageVerificationResult> {
  const archive = await JSZip.loadAsync(
    packageData instanceof Blob ? await packageData.arrayBuffer() : packageData,
  );
  const actualEntries = new Set(
    Object.values(archive.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name),
  );
  const expected = collectExpectedEntries(plan);
  const missing = expected.filter((entry) => !actualEntries.has(entry.path));
  return {
    ok: missing.length === 0,
    expectedEntryCount: expected.length,
    actualEntryCount: actualEntries.size,
    missing,
  };
}

export function collectExpectedEntries(
  plan: PackageVerificationPlan,
): MissingPackageArtifact[] {
  const resolved = resolvePlan(plan);
  const artifacts = [
    ...resolved.shots.flatMap((shot) => shot.artifacts),
    ...resolved.sharedArtifacts,
  ];
  return artifacts.flatMap((artifact) => (
    artifact.disposition === 'produce'
      ? artifact.files.map((file) => ({
        shotId: artifact.shotId,
        artifactId: artifact.id,
        kind: artifact.kind,
        path: file.path,
      }))
      : []
  ));
}
