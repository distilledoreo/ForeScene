import type {
  AutorigAutoLabelRequest,
  AutorigAutoLabelResultMessage,
  AutorigBuildTopologyRequest,
  AutorigBuildTopologyResult,
  AutorigApplyRegionOverridesRequest,
  AutorigApplyRegionOverridesResult,
  AutorigWorkerProgress,
  AutorigWorkerRequest,
  AutorigWorkerResponse,
} from './workerProtocol';
import { collectAutorigRequestTransferables } from './workerProtocol';

export interface AutorigWorkerTask<T> {
  promise: Promise<T>;
  cancel(): void;
}

function createJobId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `autorig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function runAutorigWorkerJob<T extends AutorigWorkerResponse>(
  request: AutorigWorkerRequest,
  onProgress?: (progress: AutorigWorkerProgress) => void,
): AutorigWorkerTask<T> {
  const worker = new Worker(new URL('../../workers/autorigWorker.ts', import.meta.url), {
    type: 'module',
  });
  let settled = false;
  let rejectTask: (reason?: unknown) => void = () => undefined;
  const jobId = 'jobId' in request ? request.jobId : createJobId();

  const promise = new Promise<T>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<AutorigWorkerResponse>) => {
      const message = event.data;
      if (!message || (message as { jobId?: string }).jobId !== jobId || settled) return;
      if (message.kind === 'progress') {
        onProgress?.(message);
        return;
      }
      settled = true;
      worker.terminate();
      if (message.kind === 'error') {
        reject(new Error(message.message));
        return;
      }
      if (message.kind === 'cancelled') {
        reject(new DOMException('Autorig job was cancelled.', 'AbortError'));
        return;
      }
      resolve(message as T);
    };
    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'Autorig worker failed.'));
    };
    const transfer = collectAutorigRequestTransferables(request);
    worker.postMessage(request, transfer);
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      try {
        worker.postMessage({ kind: 'cancel', jobId } satisfies AutorigWorkerRequest);
      } catch {
        // Worker may already be gone.
      }
      worker.terminate();
      rejectTask(new DOMException('Autorig job was cancelled.', 'AbortError'));
    },
  };
}

export function runAutorigBuildTopology(
  input: Omit<AutorigBuildTopologyRequest, 'kind' | 'jobId'> & { jobId?: string },
  onProgress?: (progress: AutorigWorkerProgress) => void,
): AutorigWorkerTask<AutorigBuildTopologyResult> {
  const request: AutorigBuildTopologyRequest = {
    kind: 'build-topology',
    jobId: input.jobId ?? createJobId(),
    positions: input.positions,
    triangles: input.triangles,
    meshParts: input.meshParts,
    vertexMeshPart: input.vertexMeshPart,
    triangleMeshPart: input.triangleMeshPart,
  };
  return runAutorigWorkerJob(request, onProgress);
}

export function runAutorigAutoLabel(
  input: Omit<AutorigAutoLabelRequest, 'kind' | 'jobId'> & { jobId?: string },
  onProgress?: (progress: AutorigWorkerProgress) => void,
): AutorigWorkerTask<AutorigAutoLabelResultMessage> {
  const request: AutorigAutoLabelRequest = {
    kind: 'auto-label',
    jobId: input.jobId ?? createJobId(),
    positions: input.positions,
    triangles: input.triangles,
    meshParts: input.meshParts,
    vertexMeshPart: input.vertexMeshPart,
    triangleMeshPart: input.triangleMeshPart,
    topologyHash: input.topologyHash,
    jointPositions: input.jointPositions,
    poseHint: input.poseHint,
  };
  return runAutorigWorkerJob(request, onProgress);
}

export function runAutorigApplyRegionOverrides(
  input: Omit<AutorigApplyRegionOverridesRequest, 'kind' | 'jobId'> & { jobId?: string },
  onProgress?: (progress: AutorigWorkerProgress) => void,
): AutorigWorkerTask<AutorigApplyRegionOverridesResult> {
  const request: AutorigApplyRegionOverridesRequest = {
    kind: 'apply-region-overrides',
    jobId: input.jobId ?? createJobId(),
    suggested: input.suggested,
    overrides: input.overrides,
  };
  return runAutorigWorkerJob(request, onProgress);
}
