import { useCallback, useEffect, useRef, useState } from 'react';
import { BRAND, readMigratedPreference, writePreference } from '../../config/brand';

const FADE_MS = 600;

function hasSeenSplash(): boolean {
  if (typeof window === 'undefined') return true;
  return readMigratedPreference(BRAND.prefs.splashSeen, BRAND.legacyPrefs.splashSeen) === '1';
}

function markSplashSeen() {
  writePreference(BRAND.prefs.splashSeen, '1');
}

export default function SplashScreen({ onDismissed }: { onDismissed?: () => void } = {}) {
  const [visible, setVisible] = useState(() => !hasSeenSplash());
  const [fading, setFading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dismissedRef = useRef(false);

  const dismiss = useCallback(() => {
    if (dismissedRef.current || !visible) return;
    dismissedRef.current = true;
    setFading(true);
    markSplashSeen();
    window.setTimeout(() => {
      setVisible(false);
      onDismissed?.();
    }, FADE_MS);
  }, [visible, onDismissed]);

  useEffect(() => {
    if (!visible) return;
    const video = videoRef.current;
    if (video) {
      // Attempt autoplay; many browsers require muted.
      video.muted = true;
      void video.play().catch(() => {
        // If autoplay is blocked, dismiss so the user isn't stuck.
        dismiss();
      });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, dismiss]);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-black transition-opacity duration-[${FADE_MS}ms] ${
        fading ? 'opacity-0' : 'opacity-100'
      }`}
      onClick={dismiss}
      role="dialog"
      aria-label="ForeScene splash"
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <video
        ref={videoRef}
        src={BRAND.splashVideo}
        className="h-full w-full object-contain"
        playsInline
        muted
        autoPlay
        preload="metadata"
        onEnded={dismiss}
        onClick={(e) => {
          // Prevent the parent onClick from firing twice; allow tap-to-dismiss.
          e.stopPropagation();
          dismiss();
        }}
      />
      <button
        type="button"
        onClick={dismiss}
        className="absolute bottom-6 right-6 rounded-full border border-white/30 bg-black/40 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur-sm transition hover:bg-black/60 hover:text-white"
      >
        Skip intro
      </button>
    </div>
  );
}
