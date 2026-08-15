import { useEffect, useMemo, useState } from 'react';
import type { HumanJointId, ImportedHumanoidRigProfile } from '../../domain/types';
import { HUMAN_JOINT_LABELS } from '../../engine/humanPose';
import { REQUIRED_IMPORTED_HUMANOID_JOINTS } from '../../engine/importedRig/analyzeSkeleton';
import { Modal } from './Modal';

export function ImportedRigMappingDialog({
  open,
  profile,
  confidence,
  initialMapping,
  boneOptions,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  profile: ImportedHumanoidRigProfile;
  confidence: number;
  initialMapping: Partial<Record<HumanJointId, string>>;
  boneOptions: Array<{ path: string; name: string }>;
  onCancel: () => void;
  onConfirm: (mapping: Partial<Record<HumanJointId, string>>) => void;
}) {
  const [mapping, setMapping] = useState(initialMapping);
  useEffect(() => {
    if (open) setMapping(initialMapping);
  }, [open, initialMapping]);
  const invalid = useMemo(() => {
    const missingSpine = !mapping.spine && !mapping.chest;
    return REQUIRED_IMPORTED_HUMANOID_JOINTS.some((jointId) => !mapping[jointId] && !(jointId === 'spine' && !missingSpine)) || missingSpine;
  }, [mapping]);
  const setJoint = (jointId: HumanJointId, path: string) => setMapping((current) => ({
    ...current,
    ...(path ? { [jointId]: path } : { [jointId]: undefined }),
  }));
  return (
    <Modal open={open} onClose={onCancel} title="Review imported rig mapping" size="lg" scrollBody>
      <div className="space-y-3" data-imported-rig-mapping-dialog>
        <p className="text-xs text-secondary">
          Profile: <strong>{profile}</strong> · confidence {(confidence * 100).toFixed(0)}%. Select a unique source bone for every required joint.
        </p>
        <div className="max-h-[50vh] space-y-2 overflow-auto rounded-xl border border-subtle p-3">
          {REQUIRED_IMPORTED_HUMANOID_JOINTS.map((jointId) => (
            <label key={jointId} className="grid gap-1 text-xs text-secondary sm:grid-cols-[9rem_1fr] sm:items-center">
              <span className="font-semibold">{HUMAN_JOINT_LABELS[jointId]}</span>
              <select
                value={mapping[jointId] ?? (jointId === 'spine' ? mapping.chest ?? '' : '')}
                onChange={(event) => setJoint(jointId, event.target.value)}
                className="rounded-lg border border-subtle bg-surface px-2 py-1.5 text-xs text-primary"
                data-imported-rig-joint={jointId}
              >
                <option value="">Unmapped</option>
                {boneOptions.map((bone) => <option key={bone.path} value={bone.path}>{bone.name} · {bone.path}</option>)}
              </select>
            </label>
          ))}
        </div>
        {invalid && <p className="text-xs text-rose-300">Required mappings are incomplete.</p>}
        <div className="flex justify-end gap-2 border-t border-subtle pt-3">
          <button type="button" onClick={onCancel} className="rounded-xl border border-subtle px-3 py-2 text-sm font-semibold text-secondary">Cancel</button>
          <button type="button" disabled={invalid} onClick={() => onConfirm(mapping)} className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" data-imported-rig-mapping-confirm>Use mapping</button>
        </div>
      </div>
    </Modal>
  );
}

