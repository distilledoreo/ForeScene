import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference } from '../src/domain/defaults';
import { PROJECT_ASSET_RESOURCE_PREFIX } from '../src/engine/binaryIntegrity';
import { exportAgentProjectBackup } from '../src/engine/agent/projectBackupControl';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import {
  deleteProjectAssetBlob,
  resetProjectAssetStoreForTests,
  storeProjectAssetDataUrl,
} from '../src/engine/projectAssetStore';
import { listAllProjectRevisions, resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { saveProjectRevision } from '../src/engine/projectSafety';
import { reconcileAndVerifyRecoveryResources } from '../src/engine/recoveryResources';
import { runProjectHealthCheck } from '../src/engine/projectHealth';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

async function resetSafetyStorage() {
  resetProjectAssetStoreForTests();
  resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
}

describe('recovery resource reconciliation', () => {
  beforeEach(async () => {
    await resetSafetyStorage();
    useAgentControlStore.setState({ controlMode: 'read-write' });
  });

  afterEach(async () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.getState().setFlushProject(undefined);
    await resetSafetyStorage();
  });

  it('diagnoses a missing current-project recovery PNG instead of exporting', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,YWJjZA==',
      width: 16,
      height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    })];
    const saved = await saveProjectRevision(project);
    const resource = saved.revision.resources.projectAssets?.[0];
    expect(resource?.key.startsWith(PROJECT_ASSET_RESOURCE_PREFIX)).toBe(true);

    // Benchmark failure mode: the recovery PNG blob disappears before backup/export.
    await deleteProjectAssetBlob(resource!.key);
    project.assets.assets[asset.id] = {
      ...asset,
      storageKey: resource!.key,
      uri: `panoref-asset:${resource!.key}`,
    };

    const report = await runProjectHealthCheck(project);
    expect(report.issues.some((issue) => issue.code === 'missing-recovery-resource')).toBe(true);

    const verification = await reconcileAndVerifyRecoveryResources(project);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((issue) => (
      issue.code === 'missing-recovery-resource' && issue.currentProject
    ))).toBe(true);

    useProjectStore.setState({ project });
    useProjectSafetyStore.setState({
      flushProject: async () => ({
        project,
        revision: saved.revision,
      }) as never,
    });
    const backup = await exportAgentProjectBackup({ download: false });
    expect(backup.ok).toBe(false);
    expect(backup.diagnostics.some((item) => item.code === 'missing-recovery-resource')).toBe(true);
    expect(backup.recovery?.ok).toBe(false);
  });

  it('does not drop a current-project recovery PNG marked missing from reconciliation', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,YWJjZA==',
      width: 16,
      height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    })];
    const saved = await saveProjectRevision(project);
    const resource = saved.revision.resources.projectAssets?.[0];
    expect(resource?.key.startsWith(PROJECT_ASSET_RESOURCE_PREFIX)).toBe(true);

    await deleteProjectAssetBlob(resource!.key);
    project.assets.assets[asset.id] = {
      ...asset,
      storageKey: resource!.key,
      uri: `panoref-asset:${resource!.key}`,
      resolutionStatus: 'missing',
    };

    const verification = await reconcileAndVerifyRecoveryResources(project);
    expect(verification.ok).toBe(false);
    expect(verification.prunedHistoricalResources).toBe(0);
    expect(verification.issues.some((issue) => (
      issue.code === 'missing-recovery-resource' && issue.currentProject && issue.key === resource!.key
    ))).toBe(true);

    const revisions = await listAllProjectRevisions();
    expect(revisions.some((revision) => revision.resources.projectAssetKeys.includes(resource!.key))).toBe(true);

    useProjectStore.setState({ project });
    useProjectSafetyStore.setState({
      flushProject: async () => ({
        project,
        revision: saved.revision,
      }) as never,
    });
    const backup = await exportAgentProjectBackup({ download: false });
    expect(backup.ok).toBe(false);
    expect(backup.diagnostics.some((item) => (
      item.code === 'missing-recovery-resource' || item.code === 'ASSET_MISSING'
    ))).toBe(true);
    expect(backup.recovery?.ok).toBe(false);
  });

  it('blocks a missing live project binary even when no revision lists it yet', async () => {
    const project = createDefaultProject();
    const orphanKey = `${PROJECT_ASSET_RESOURCE_PREFIX}${'b'.repeat(64)}/image%2Fpng`;
    const asset = createPanoAsset({
      name: 'live-only.png',
      uri: `panoref-asset:${orphanKey}`,
      width: 16,
      height: 8,
    });
    project.assets.assets[asset.id] = {
      ...asset,
      storageKey: orphanKey,
      resolutionStatus: 'available',
    };
    const verification = await reconcileAndVerifyRecoveryResources(project);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((issue) => (
      issue.code === 'missing-recovery-resource' && issue.currentProject && issue.key === orphanKey
    ))).toBe(true);
  });

  it('rematerializes a missing recovery PNG from a live data URL', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,YWJjZA==',
      width: 16,
      height: 8,
    }));
    const recoveryKey = `${PROJECT_ASSET_RESOURCE_PREFIX}${'a'.repeat(64)}/image%2Fpng`;
    project.assets.assets[asset.id] = {
      ...asset,
      storageKey: recoveryKey,
      uri: 'data:image/png;base64,YWJjZA==',
    };
    const verification = await reconcileAndVerifyRecoveryResources(project);
    expect(verification.rematerialized).toBeGreaterThan(0);
    expect(verification.issues.filter((issue) => issue.currentProject)).toHaveLength(0);
  });

  it('prunes a vanished historical recovery resource from revision manifests', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,YWJjZA==',
      width: 16,
      height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    })];
    const saved = await saveProjectRevision(project);
    const historicalKey = saved.revision.resources.projectAssetKeys[0]!;
    expect(historicalKey).toBeTruthy();
    await deleteProjectAssetBlob(historicalKey);

    const nextAsset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'replacement.png',
      uri: 'data:image/png;base64,eHl6eg==',
      width: 16,
      height: 8,
    }));
    project.assets.assets = { [nextAsset.id]: nextAsset };
    project.panoRefs = [createPanoReference({
      name: 'Replacement',
      assetId: nextAsset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    })];

    const verification = await reconcileAndVerifyRecoveryResources(project);
    expect(verification.prunedHistoricalResources).toBeGreaterThan(0);
    expect(verification.ok).toBe(true);
  });
});
