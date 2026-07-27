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
  peopleExportMode?: PeopleExportMode;
  onPeopleExportMode?: (mode: PeopleExportMode) => void;
  title?: string;
  children?: React.ReactNode;
}

/** Shot / camera settings drawer — composition surface for advanced Shots controls. */
export function ShotSettings({
  open,
  onClose,
  shot,
  onUpdate,
  peopleExportMode,
  onPeopleExportMode,
  title = 'Camera Settings',
  children,
}: ShotSettingsProps) {
  return (
    <PrecisionDrawer
      open={open && Boolean(shot)}
      onClose={onClose}
      title={title}
    >
      {shot && (
        <div className="space-y-4" data-shot-settings data-shots-advanced-settings>
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
              rows={2}
            />
          </Field>
          {peopleExportMode !== undefined && onPeopleExportMode && (
            <Field label="People export" hint="Clean plate keeps the same camera and staging but hides every object classified as a person.">
              <Select
                value={peopleExportMode}
                onChange={(event) => onPeopleExportMode(event.target.value as PeopleExportMode)}
                data-shots-people-export-mode
              >
                <option value="with_people">With people</option>
                <option value="clean_plate">Clean plate</option>
                <option value="both">Both</option>
              </Select>
            </Field>
          )}
          {children}
        </div>
      )}
    </PrecisionDrawer>
  );
}
