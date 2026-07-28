import React from 'react';
import type { HumanJointId, HumanPose } from '../../domain/types';
import {
  HUMAN_JOINT_IDS,
  HUMAN_JOINT_LABELS,
  cloneHumanPose,
  createEmptyHumanPose,
  mirrorHumanPose,
  resetHumanJoint,
} from '../../engine/humanPose';
import {
  HUMAN_POSE_PRESETS,
  applyHumanPosePreset,
} from '../../engine/humanPosePresets';

export function CharacterPosePanel({
  pose,
  selectedJointId,
  onSelectJoint,
  onChangePose,
  className = '',
}: {
  pose: HumanPose | undefined;
  selectedJointId?: HumanJointId;
  onSelectJoint: (jointId: HumanJointId | undefined) => void;
  onChangePose: (pose: HumanPose) => void;
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
          onClick={() => onChangePose(createEmptyHumanPose())}
        >
          Reset pose
        </button>
        <button
          type="button"
          className="rounded-lg border border-subtle px-2 py-1 text-[11px] font-semibold text-secondary hover:bg-surface-raised"
          data-pose-mirror
          onClick={() => onChangePose(mirrorHumanPose(current))}
        >
          Mirror pose
        </button>
        {selectedJointId && (
          <button
            type="button"
            className="rounded-lg border border-subtle px-2 py-1 text-[11px] font-semibold text-secondary hover:bg-surface-raised"
            data-pose-reset-joint
            onClick={() => onChangePose(resetHumanJoint(current, selectedJointId))}
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
              onClick={() => onChangePose(applyHumanPosePreset(preset.id))}
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
                className={`rounded-lg px-2 py-1.5 text-left text-[11px] transition ${
                  active
                    ? 'bg-accent text-white'
                    : posed
                      ? 'bg-surface-raised text-primary'
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
        />
      )}
    </div>
  );
}

function JointRotationEditor({
  jointId,
  pose,
  onChangePose,
}: {
  jointId: HumanJointId;
  pose: HumanPose;
  onChangePose: (pose: HumanPose) => void;
}) {
  const rotation = pose.joints[jointId]?.rotation ?? [0, 0, 0, 1];
  // Display approximate Euler XYZ degrees derived from the quaternion for direct edits.
  const euler = quaternionToApproximateEulerDegrees(rotation);

  const patchAxis = (axis: 0 | 1 | 2, degrees: number) => {
    const nextEuler: [number, number, number] = [...euler];
    nextEuler[axis] = degrees;
    const next = cloneHumanPose(pose) ?? createEmptyHumanPose();
    next.joints[jointId] = {
      rotation: eulerDegreesToQuaternionLocal(nextEuler[0], nextEuler[1], nextEuler[2]),
      ...(jointId === 'hips' && pose.joints.hips?.position
        ? { position: pose.joints.hips.position }
        : {}),
    };
    delete next.presetId;
    onChangePose(next);
  };

  return (
    <div className="space-y-2 rounded-xl border border-subtle p-2" data-pose-joint-editor>
      <div className="text-[11px] font-semibold text-primary">
        {HUMAN_JOINT_LABELS[jointId]} rotation
      </div>
      {(['X', 'Y', 'Z'] as const).map((label, axis) => (
        <label key={label} className="flex items-center gap-2 text-[11px] text-secondary">
          <span className="w-4 font-semibold">{label}</span>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={Math.round(euler[axis])}
            onChange={(event) => patchAxis(axis as 0 | 1 | 2, Number(event.target.value))}
            className="min-w-0 flex-1 accent-[var(--accent)]"
            data-pose-joint-axis={label.toLowerCase()}
          />
          <span className="w-8 tabular-nums text-right">{Math.round(euler[axis])}°</span>
        </label>
      ))}
    </div>
  );
}

function eulerDegreesToQuaternionLocal(
  xDegrees: number,
  yDegrees: number,
  zDegrees: number,
): [number, number, number, number] {
  const x = (xDegrees * Math.PI) / 180;
  const y = (yDegrees * Math.PI) / 180;
  const z = (zDegrees * Math.PI) / 180;
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
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
