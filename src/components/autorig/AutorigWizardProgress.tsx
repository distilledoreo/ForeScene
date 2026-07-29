import React from 'react';
import type { AutorigWizardStepId } from '../../engine/autorig/regionDraftStore';

const STEPS: Array<{ id: AutorigWizardStepId; label: string; hint: string }> = [
  { id: 'joints', label: 'Joints', hint: 'Place markers' },
  { id: 'regions', label: 'Body parts', hint: 'Correct colors' },
  { id: 'preview', label: 'Check pose', hint: 'Review & apply' },
];

export function AutorigWizardProgress({
  step,
}: {
  step: AutorigWizardStepId;
}) {
  const activeIndex = STEPS.findIndex((item) => item.id === step);
  return (
    <ol className="flex flex-wrap items-center gap-2" data-autorig-wizard-progress>
      {STEPS.map((item, index) => {
        const active = item.id === step;
        const done = index < activeIndex;
        return (
          <li key={item.id} className="flex items-center gap-2">
            {index > 0 && <span className="text-muted" aria-hidden>→</span>}
            <div
              className={`rounded-lg px-2.5 py-1.5 text-xs ${
                active
                  ? 'bg-accent text-white'
                  : done
                    ? 'bg-surface-muted text-primary'
                    : 'bg-surface-muted/60 text-muted'
              }`}
              data-autorig-wizard-step={item.id}
              data-active={active ? 'true' : 'false'}
            >
              <div className="font-semibold">{index + 1}. {item.label}</div>
              <div className={`text-[10px] ${active ? 'text-white/80' : 'text-muted'}`}>{item.hint}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
