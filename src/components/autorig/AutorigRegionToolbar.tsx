import React from 'react';
import type { AutorigBodyRegionId } from '../../engine/autorig/regions';
import { AUTORIG_BODY_REGION_IDS } from '../../engine/autorig/regions';
import { AUTORIG_REGION_LABELS, regionColorCss } from '../../engine/autorig/regionOverlay';

export function AutorigRegionToolbar({
  selected,
  onSelect,
}: {
  selected: AutorigBodyRegionId;
  onSelect: (region: AutorigBodyRegionId) => void;
}) {
  return (
    <div className="space-y-2" data-autorig-region-toolbar>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Body part</div>
      <div className="grid grid-cols-2 gap-1.5">
        {AUTORIG_BODY_REGION_IDS.map((region) => {
          const active = selected === region;
          return (
            <button
              key={region}
              type="button"
              onClick={() => onSelect(region)}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold ${
                active ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'
              }`}
              data-autorig-region={region}
              data-active={active ? 'true' : 'false'}
            >
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-sm border border-black/20"
                style={{ background: regionColorCss(region) }}
                aria-hidden
              />
              {AUTORIG_REGION_LABELS[region]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
