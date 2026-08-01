import React from 'react';
import { Boxes, Globe } from 'lucide-react';
import { BRAND } from '../../config/brand';
import { AppMode, useAppModeStore } from '../../state/useAppModeStore';

export function ModeChooser({ visible }: { visible: boolean }) {
  const setAppMode = useAppModeStore((state) => state.setAppMode);

  if (!visible) return null;

  const choose = (mode: AppMode) => {
    setAppMode(mode);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-surface-base/95 p-6 backdrop-blur-sm"
      role="dialog"
      aria-label="Choose app mode"
      data-mode-chooser
    >
      <div className="w-full max-w-xl space-y-6 rounded-[var(--radius-card)] border border-subtle bg-surface-raised p-6 shadow-soft">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold text-primary">What do you want to do?</h1>
          <p className="text-sm text-secondary">{BRAND.modeChooserIntro}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ModeCard
            icon={<Boxes className="h-7 w-7" />}
            title="Open ForeScene"
            description="Sets, characters, shots, and production handoffs. A starter launcher appears when the project is blank."
            onClick={() => choose('studio')}
            dataMode="studio"
          />
          <ModeCard
            icon={<Globe className="h-7 w-7" />}
            title="Just view a 360 pano"
            description="Import an equirectangular image, look around, download the current view."
            onClick={() => choose('panoViewer')}
            dataMode="pano-viewer"
            recommended
          />
        </div>
        <p className="text-center text-xs text-muted">You can switch modes anytime from the brand menu.</p>
      </div>
    </div>
  );
}

function ModeCard({
  icon,
  title,
  description,
  onClick,
  dataMode,
  recommended,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  dataMode: string;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-mode-option={dataMode}
      className="flex flex-col items-start gap-3 rounded-2xl border border-subtle bg-surface-muted/60 p-4 text-left transition hover:border-[var(--accent)] hover:bg-accent-soft/40 hover:shadow-card"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-primary">{title}</span>
          {recommended && (
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary">
              Simple
            </span>
          )}
        </div>
        <p className="text-sm leading-snug text-secondary">{description}</p>
      </div>
    </button>
  );
}
