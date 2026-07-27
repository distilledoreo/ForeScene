import React from 'react';
import type { PeopleExportMode, Shot, ShotStatus } from '../../domain/types';
import { Field, Select, TextArea, TextInput } from '../common/Field';
import { PrecisionDrawer } from '../common/PrecisionDrawer';

const statuses: ShotStatus[] = ['planned', 'exported', 'needs_fix', 'approved', 'rejected'];
const STATUS_LABELS: Record<ShotStatus, string> = {
  planned: 'Planned',
  exported: 'Exported',
  needs_fix: 'Needs fix',
  approved: 'Approved',
  rejected: 'Rejected',
};

export interface ShotSettingsProps {
  open: boolean;
  onClose: () => void;
  shot?: Shot;
  onUpdate: (updates: Partial<Shot>) => void;
  peopleExportMode: PeopleExportMode;
  onPeopleExportMode: (mode: PeopleExportMode) => void;
  children?: React.ReactNode;
}

/** Shot settings drawer (status, notes, export people mode, extensible children). */
export function ShotSettings({
  open,
  onClose,
  shot,
  onUpdate,
  peopleExportMode,
  onPeopleExportMode,
  children,
}: ShotSettingsProps) {
  if (!shot) return null;

  return (
    <PrecisionDrawer
      open={open}
      onClose={onClose}
      title="Shot settings"
    >
      <div className="space-y-3 p-1" data-shot-settings data-shot-settings-panel>
        <Field label="Title">
          <TextInput
            value={shot.name}
            onChange={(event) => onUpdate({ name: event.target.value })}
          />
        </Field>
        <Field label="Production ID">
          <TextInput
            value={shot.productionShotId ?? ''}
            onChange={(event) => onUpdate({ productionShotId: event.target.value })}
          />
        </Field>
        <Field label="Status">
          <Select
            value={shot.status}
            onChange={(event) => onUpdate({ status: event.target.value as ShotStatus })}
          >
            {statuses.map((status) => (
              <option key={status} value={status}>{STATUS_LABELS[status]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Description">
          <TextArea
            value={shot.description ?? ''}
            onChange={(event) => onUpdate({ description: event.target.value })}
            rows={3}
          />
        </Field>
        <Field label="People export">
          <Select
            value={peopleExportMode}
            onChange={(event) => onPeopleExportMode(event.target.value as PeopleExportMode)}
          >
            <option value="with_people">With people</option>
            <option value="clean_plate">Clean plate</option>
            <option value="both">Both</option>
          </Select>
        </Field>
        {children}
      </div>
    </PrecisionDrawer>
  );
}
