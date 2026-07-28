import React from 'react';
import type { HumanJointId, HumanPose } from '../../domain/types';
import {
  HUMAN_JOINT_IDS,
  HUMAN_JOINT_LABELS,
  cloneHumanPose,
  createEmptyHumanPose,
  eulerDegreesToQuaternion,
  mirrorHumanPose,
  resetHumanJoint,
} from '../../engine/humanPose';
import {
  HUMAN_POSE_PRESETS,
  applyHumanPosePreset,
} from '../../engine/humanPosePresets';
import {
  HUMAN_JOINT_LIMITS_DEGREES,
  clampHumanJointEulerDegrees,
} from '../../engine/humanoidSkeleton';

export function CharacterPosePanel({
  pose,
  selectedJointId,
  onSelectJoint,
  onChangePose,
  onPoseEditBatchStart,
  onPoseEditBatchEnd,
  className = '',
}: {
  pose: HumanPose | undefined;
  selectedJointId?: HumanJointId;
  onSelectJoint: (jointId: HumanJointId | undefined) => void;
  onChangePose: (pose: HumanPose, options?: { history?: 'step' | 'batch' }) => void;
  /** Match transform-gizmo batching so slider drags make one undo step. */
  onPoseEditBatchStart?: () => void;
  onPoseEditBatchEnd?: () => void;
  className?: string;
}) {
  const current = pose ?? createEmptyHumanPose();

  return (
    <div className={`space-y-3 ${className}`} data-character-pose-panel>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className="rounded-lg border border-subtle px-2 py-1 text-[11px] font-semibold text-secondary hover:bg-surface-raised"
          data-pose-reset-all
          onClick={() => onChangePose(createEmptyHumanPose(), { history: 'step' })}
        >
          Reset pose
        </button>
        <button
          type="button"
          className="rounded-lg border border-subtle px-2 py-1 text-[11px] font-semibold text-secondary hover:bg-surface-raised"
          data-pose-mirror
          onClick={() => onChangePose(mirrorHumanPose(current), { history: 'step' })}
        >
          Mirror pose
        </button>
        {selectedJointId && (
          <button
            type="button"
            className="rounded-lg border border-subtle px-2 py-1 text-[11px] font-semibold text-secondary hover:bg-surface-raised"
            data-pose-reset-joint
            onClick={() => onChangePose(resetHumanJoint(current, selectedJointId), { history: 'step' })}
          >
            Reset joint
          </button>
        )}
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Presets</div>
        <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto" data-pose-preset-list>
          {HUMAN_POSE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-pose-preset={preset.id}
              className={`rounded-full px-2 py-1 text-[10px] font-semibold transition ${
                current.presetId === preset.id
                  ? 'bg-accent text-white'
                  : 'bg-surface-muted text-secondary hover:bg-surface-raised'
              }`}
              onClick={() => onChangePose(applyHumanPosePreset(preset.id), { history: 'step' })}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Joints</div>
        <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto" data-pose-joint-list>
          {HUMAN_JOINT_IDS.map((jointId) => {
            const active = selectedJointId === jointId;
            const posed = Boolean(current.joints[jointId]);
            return (
              <button
                key={jointId}
                type="button"
                data-pose-joint={jointId}
                aria-pressed={active}
                className={`rounded-lg px-2 py-1 text-left text-[10px] font-semibold transition ${
                  active
                    ? 'bg-accent text-white'
                    : posed
                      ? 'bg-surface-raised text-primary hover:bg-surface-muted'
                      : 'bg-surface-muted text-secondary hover:bg-surface-raised'
                }`}
                onClick={() => onSelectJoint(active ? undefined : jointId)}
              >
                {HUMAN_JOINT_LABELS[jointId]}
              </button>
            );
          })}
        </div>
      </div>

      {selectedJointId && (
        <JointRotationEditor
          jointId={selectedJointId}
          pose={current}
          onChangePose={onChangePose}
          onPoseEditBatchStart={onPoseEditBatchStart}
          onPoseEditBatchEnd={onPoseEditBatchEnd}
        />
      )}
    </div>
  );
}

function JointRotationEditor({
  jointId,
  pose,
  onChangePose,
  onPoseEditBatchStart,
  onPoseEditBatchEnd,
}: {
  jointId: HumanJointId;
  pose: HumanPose;
  onChangePose: (pose: HumanPose, options?: { history?: 'step' | 'batch' }) => void;
  onPoseEditBatchStart?: () => void;
  onPoseEditBatchEnd?: () => void;
}) {
  const rotation = pose.joints[jointId]?.rotation ?? [0, 0, 0, 1];
  // Keep the true Euler from the stored quaternion. Do not clamp all axes up front —
  // that would rewrite preset values the moment another axis is touched.
  const euler = quaternionToApproximateEulerDegrees(rotation);
  const limits = HUMAN_JOINT_LIMITS_DEGREES[jointId];

  const patchAxis = (axis: 0 | 1 | 2, degrees: number) => {
    const nextEuler: [number, number, number] = [...euler];
    nextEuler[axis] = degrees;
    // Clamp only after the edit, and keep sibling axes as stored.
    const clamped = clampHumanJointEulerDegrees(jointId, nextEuler);
    const next = cloneHumanPose(pose) ?? createEmptyHumanPose();
    next.joints[jointId] = {
      rotation: eulerDegreesToQuaternion(clamped[0], clamped[1], clamped[2]),
      ...(jointId === 'hips' && pose.joints.hips?.position
        ? { position: pose.joints.hips.position }
        : {}),
    };
    delete next.presetId;
    onChangePose(next, { history: 'batch' });
  };

  const beginBatch = () => onPoseEditBatchStart?.();
  const endBatch = () => onPoseEditBatchEnd?.();

  return (
    <div className="space-y-2 rounded-xl border border-subtle p-2" data-pose-joint-editor>
      <div className="text-[11px] font-semibold text-primary">
        {HUMAN_JOINT_LABELS[jointId]} rotation
      </div>
      {(['X', 'Y', 'Z'] as const).map((label, axis) => {
        const raw = euler[axis];
        const display = Math.round(
          Math.min(limits.max[axis], Math.max(limits.min[axis], raw)),
        );
        return (
          <label key={label} className="flex items-center gap-2 text-[11px] text-secondary">
            <span className="w-4 font-semibold">{label}</span>
            <input
              type="range"
              min={limits.min[axis]}
              max={limits.max[axis]}
              step={1}
              value={display}
              onPointerDown={beginBatch}
              onPointerUp={endBatch}
              onPointerCancel={endBatch}
              onBlur={endBatch}
              onChange={(event) => patchAxis(axis as 0 | 1 | 2, Number(event.target.value))}
              className="min-w-0 flex-1 accent-[var(--accent)]"
              data-pose-joint-axis={label.toLowerCase()}
            />
            <span className="w-8 tabular-nums text-right">{Math.round(raw)}°</span>
          </label>
        );
      })}
    </div>
  );
}

function quaternionToApproximateEulerDegrees(
  q: [number, number, number, number],
): [number, number, number] {
  const [x, y, z, w] = q;
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1
    ? Math.sign(sinp) * (Math.PI / 2)
    : Math.asin(sinp);

  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);

  return [
    (roll * 180) / Math.PI,
    (pitch * 180) / Math.PI,
    (yaw * 180) / Math.PI,
  ];
}
