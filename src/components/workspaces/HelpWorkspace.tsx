import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Boxes,
  Camera,
  CheckCircle2,
  Clapperboard,
  Download,
  FileJson,
  Globe2,
  Lightbulb,
  PackageOpen,
  Search,
  Settings2,
  Upload,
} from 'lucide-react';
import { Workspace } from '../../domain/types';
import { useContinuityStore } from '../../state/useContinuityStore';

interface HelpWorkspaceProps {
  onClose: () => void;
}

const navGroups = [
  {
    label: 'Start here',
    items: [
      { id: 'welcome', label: 'Welcome' },
      { id: 'quick-start', label: 'Quick start' },
      { id: 'workflow', label: 'The workflow' },
    ],
  },
  {
    label: 'Workspaces',
    items: [
      { id: 'build', label: 'Build' },
      { id: 'reference', label: 'Reference' },
      { id: 'shots', label: 'Shots' },
      { id: 'export', label: 'Export' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { id: 'shortcuts', label: 'Keyboard shortcuts' },
      { id: 'projects', label: 'Project files' },
      { id: 'troubleshooting', label: 'Troubleshooting' },
    ],
  },
] as const;

const searchableSections: Record<string, string> = {
  welcome: 'overview continuity stage panorama graybox camera handoff documentation',
  'quick-start': 'new project build reference shots export first package steps',
  workflow: 'build reference shots export checkpoints stages',
  build: 'objects primitives multi-select transform gizmo cut copy paste panorama render distance orbit free camera WASD projected 360 inpainting',
  reference: '360 panorama alignment yaw origin landmarks approve',
  shots: 'camera still video capture keyframes framing gallery thumbnails',
  export: 'zip package shots metadata prompts cubemap download',
  shortcuts: 'keyboard hotkeys clipboard copy cut paste duplicate undo redo nudge frame',
  projects: 'save open json schema assets local file',
  troubleshooting: 'browser mp4 clipboard panorama slow export error',
};

export function HelpWorkspace({ onClose }: HelpWorkspaceProps) {
  const [query, setQuery] = useState('');
  const setWorkspace = useContinuityStore((state) => state.setWorkspace);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleIds = useMemo(() => {
    if (!normalizedQuery) return new Set(Object.keys(searchableSections));
    const terms = normalizedQuery.split(/\s+/);
    return new Set(Object.entries(searchableSections)
      .filter(([, value]) => terms.every((term) => value.includes(term)))
      .map(([id]) => id));
  }, [normalizedQuery]);

  const openWorkspace = (workspace: Workspace) => {
    setWorkspace(workspace);
    onClose();
  };

  const jumpTo = (id: string) => {
    document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-base pt-[7.25rem] md:pt-[5.5rem]" data-help-workspace>
      <div className="mx-auto grid w-full max-w-[1500px] gap-8 px-4 pb-20 md:grid-cols-[250px_minmax(0,1fr)] md:px-8 lg:gap-12">
        <aside className="md:sticky md:top-24 md:h-[calc(100vh-7rem)] md:self-start md:overflow-y-auto md:pr-3">
          <button
            type="button"
            onClick={onClose}
            className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-subtle bg-surface-raised px-3 text-sm font-medium text-secondary transition hover:border-accent hover:text-accent"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to the app
          </button>

          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documentation"
              aria-label="Search documentation"
              className="h-11 w-full rounded-xl border border-subtle bg-surface-raised pl-9 pr-3 text-sm text-primary outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-[var(--accent-glow)]"
            />
          </label>

          <select
            aria-label="Documentation section"
            className="mt-3 h-11 w-full rounded-xl border border-subtle bg-surface-raised px-3 text-sm text-primary md:hidden"
            onChange={(event) => jumpTo(event.target.value)}
            defaultValue="welcome"
          >
            {navGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </optgroup>
            ))}
          </select>

          <nav className="mt-6 hidden space-y-6 md:block" aria-label="Documentation navigation">
            {navGroups.map((group) => (
              <div key={group.label}>
                <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => jumpTo(item.id)}
                      className={`block w-full rounded-lg px-2.5 py-2 text-left text-sm transition ${
                        visibleIds.has(item.id)
                          ? 'text-secondary hover:bg-surface-muted hover:text-primary'
                          : 'text-muted opacity-35'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          {normalizedQuery && visibleIds.size === 0 && (
            <div className="rounded-2xl border border-subtle bg-surface-raised p-8 text-center">
              <Search className="mx-auto h-8 w-8 text-muted" />
              <h1 className="mt-3 text-xl font-semibold text-primary">No documentation matched “{query}”</h1>
              <p className="mt-2 text-sm text-secondary">Try “clipboard,” “360,” “shots,” or “export.”</p>
            </div>
          )}

          <DocSection id="welcome" visible={visibleIds.has('welcome')}>
            <div className="overflow-hidden rounded-[28px] border border-subtle bg-gradient-to-br from-surface-raised via-surface-raised to-accent-soft p-6 shadow-card sm:p-10">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-white shadow-[0_0_28px_var(--accent-glow)]">
                <BookOpen className="h-6 w-6" />
              </div>
              <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-accent">Continuity Stage documentation</p>
              <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight text-primary sm:text-5xl">
                Build a location once. Keep every shot consistent.
              </h1>
              <p className="mt-5 max-w-3xl text-base leading-7 text-secondary sm:text-lg">
                Continuity Stage turns a rough 3D set, a canonical 360 reference, and camera choices into a portable handoff package for image and video workflows.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <button type="button" onClick={() => jumpTo('quick-start')} className="inline-flex min-h-11 items-center rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[var(--accent-hover)]">
                  Start the quick guide
                </button>
                <button type="button" onClick={() => jumpTo('shortcuts')} className="inline-flex min-h-11 items-center rounded-xl border border-subtle bg-surface-overlay px-4 text-sm font-semibold text-secondary hover:border-accent hover:text-accent">
                  View shortcuts
                </button>
              </div>
            </div>
          </DocSection>

          <DocSection id="quick-start" visible={visibleIds.has('quick-start')} title="Quick start" eyebrow="Five-minute orientation">
            <p className="doc-lead">Move through the four workspaces from left to right. Each stage produces the inputs needed by the next one.</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <StepCard number="1" title="Block the set" text="Stamp simple objects in Build, place the pano origin, and render a graybox 360." icon={<Boxes className="h-5 w-5" />} onClick={() => openWorkspace('build')} />
              <StepCard number="2" title="Set the reference" text="Import or approve a canonical 2:1 panorama, then align it to the graybox." icon={<Globe2 className="h-5 w-5" />} onClick={() => openWorkspace('reference')} />
              <StepCard number="3" title="Land cameras" text="Capture stills, or record → stop a two-point camera move in Shots." icon={<Clapperboard className="h-5 w-5" />} onClick={() => openWorkspace('shots')} />
              <StepCard number="4" title="Export the handoff" text="Choose shots and download a ZIP with visual references, camera data, and prompts." icon={<Upload className="h-5 w-5" />} onClick={() => openWorkspace('export')} />
            </div>
            <Tip>Save the project JSON regularly. Export ZIPs are deliverables; the project JSON is the editable source.</Tip>
          </DocSection>

          <DocSection id="workflow" visible={visibleIds.has('workflow')} title="The workflow" eyebrow="Build → Reference → Shots → Export">
            <Screenshot src="/docs/workflow-overview.png" alt="Current Continuity Stage Export workspace" caption="Export organizes each selected shot into a clear package of references, camera data, metadata, and prompts." />
            <div className="mt-6 grid gap-4 lg:grid-cols-4">
              <WorkflowCard icon={<Boxes />} title="Build" output="Graybox 360" />
              <WorkflowCard icon={<Camera />} title="Reference" output="Aligned canonical pano" />
              <WorkflowCard icon={<Clapperboard />} title="Shots" output="Camera compositions" />
              <WorkflowCard icon={<PackageOpen />} title="Export" output="Portable ZIP handoff" />
            </div>
          </DocSection>

          <DocSection id="build" visible={visibleIds.has('build')} title="Build workspace" eyebrow="Block the physical scene">
            <p className="doc-lead">Use readable primitives instead of detailed modeling. What matters is scale, silhouette, openings, camera clearance, and a trustworthy panorama origin.</p>
            <Screenshot src="/docs/build-workspace.png" alt="Current Build workspace with a selected graybox object" caption="Select one or many objects, transform around shared bounds, and render a 360 reference when the layout is ready." />
            <FeatureGrid items={[
              ['Stamp objects', 'Use the bottom tray or number keys 1–9/0. Click the floor to place each piece.'],
              ['Select and transform', 'Click, Shift-click, or Ctrl/Cmd-click. Multi-object gizmos use the shared bounding-box center.'],
              ['Clipboard editing', 'Cut, copy, paste, duplicate, and undo work on the full selection. Paste cascades; Shift+Paste preserves coordinates.'],
              ['Import 3D geometry', 'Open More > Import 3D scene. Export GLB from Blender, FBX from Maya, GLB from Unreal, then import. Choose Keep objects separate (default) or Combine into one object. World-space layout preserved, hierarchy flattened, textures/materials stripped.'],
              ['Pano origin', 'Press O to edit the capture origin with translate/rotate gizmos (T/E). Each imported/rendered reference pano keeps its own frozen origin; moving the capture origin after a styled pano is loaded warns you because projection stays locked to those panos.'],
              ['Free camera', 'The viewport defaults to orbit/select. Toggle Free camera to drag-look and walk with WASD; Space/Shift move vertically and double-tap W to sprint. Esc exits without changing the scene, and selected-object controls return when you exit. On phones, use the on-screen pad and Up/Dn controls to move.'],
              ['Projected Style', 'After importing and aligning a styled panorama, switch Appearance to Projected in Build or Shots to preview that look on geometry. With multiple origins, Reference → Projected Style can blend primary/secondary panos (primary only, secondary only, or dominant + fill). Captures and packages include clay control frames plus projected companions when a styled pano is available.'],
              ['Visibility distance', 'Open the adjacent Visibility distance control in Build to adjust both how far the viewport draws and where the fog/shroud obscures the set. It changes the Build viewport only, not shot or export cameras.'],
              ['Scene guides', 'The eye control reveals helpers and camera frustums without including them in renders.'],
              ['Render 360', 'Create a native 4K (4096×2048) graybox panorama for alignment and export.'],
              ['Download Projected 360', 'After a styled panorama is imported: render a 4K equirect from the current capture origin with Projected Style baked onto geometry. Move the origin (e.g. coverage optimizer B), download, inpaint weak regions, then import as a second panorama.'],
            ]} />
          </DocSection>

          <DocSection id="reference" visible={visibleIds.has('reference')} title="Reference workspace" eyebrow="Establish visual truth">
            <p className="doc-lead">The canonical panorama defines the location’s appearance. Use a true 2:1 equirectangular image whenever possible.</p>
            <Checklist items={[
              'Import the styled or photographed canonical panorama.',
              'Compare it with the graybox and adjust yaw until major openings and landmarks agree.',
              'Use graybox fade to inspect alignment without losing the photographic context.',
              'Approve the reference, then optionally Fill missing areas (suggest a second vantage or place it in Build).',
              'If capture origin moved: Add second capture to blend; same origin replaces the reference instead.',
            ]} />
            <Tip>Non-2:1 images can be imported, but 360 viewing may distort. Letterboxed 16:9 inputs are detected and extracted when possible. Use the on-canvas Panoramas card or Settings for imports — not only the alignment panel.</Tip>
          </DocSection>

          <DocSection id="shots" visible={visibleIds.has('shots')} title="Shots workspace" eyebrow="Choose cameras and motion">
            <p className="doc-lead">Treat Shots like a live phone camera inside the graybox. The viewfinder stays live after capture so you can move directly to the next composition.</p>
            <FeatureGrid items={[
              ['Still mode', 'Fly the camera, set the FOV, and press Capture at 4K (3840×2160) by default. A persisted thumbnail is added to the library.'],
              ['Video mode', 'Capture start, then capture the next pose. After two poses, choose Finish capture or Capture next for more. The timeline appears after a third pose or Edit timeline. When finished: Next shot (primary), Preview, or optional Export MP4. Undo restores keyframes and capture state together. Preview plays camera + staged objects; Render MP4 encodes Resolve-safe 1080p30 H.264.'],
              ['Shot library', 'Open the bottom-left thumbnail to review, rename, duplicate, or delete captured shots.'],
              ['Camera settings', 'Fine-tune FOV, duration, keyframes, preview downloads, and pano matching.'],
            ]} />
          </DocSection>

          <DocSection id="export" visible={visibleIds.has('export')} title="Export workspace" eyebrow="Package the handoff">
            <p className="doc-lead">Select one or more shots and download a single ZIP. Each shot receives its own folder so batch downloads are not blocked by the browser.</p>
            <div className="mt-6 rounded-2xl border border-subtle bg-surface-raised p-5">
              <div className="flex items-center gap-3">
                <Download className="h-5 w-5 text-accent" />
                <h3 className="font-semibold text-primary">What the package can contain</h3>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {['Viewport clay frames and motion', 'Canonical pano and perspective crop', 'Cubemap faces and stitched reference', 'Camera transforms and keyframes', 'Image/video prompts and notes', 'Manifest describing every included file'].map((item) => (
                  <div key={item} className="flex gap-2 text-sm text-secondary"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />{item}</div>
                ))}
              </div>
            </div>
          </DocSection>

          <DocSection id="shortcuts" visible={visibleIds.has('shortcuts')} title="Keyboard shortcuts" eyebrow="Move quickly in Build">
            <ShortcutTable />
          </DocSection>

          <DocSection id="projects" visible={visibleIds.has('projects')} title="Project files" eyebrow="Save editable state">
            <div className="grid gap-4 sm:grid-cols-2">
              <InfoCard icon={<FileJson />} title="Projects & backups" text="Open the Continuity Stage menu to start a New Project (current work is kept as a local recovery point), Import Project Backup, or Export Project Backup. Backups are validated before import and include scene objects, references, shots, settings, workflow checkpoints, and local binary media. Use Project Safety & Recovery to restore a previous autosave." />
              <InfoCard icon={<Upload />} title="Export ZIP" text="The export package is a handoff artifact, not an editable project. Keep the JSON if you expect to revise the location later." />
            </div>
            <Tip>Project data stays local to the browser until you explicitly open, save, or download a file.</Tip>
          </DocSection>

          <DocSection id="troubleshooting" visible={visibleIds.has('troubleshooting')} title="Troubleshooting" eyebrow="Common fixes">
            <Troubleshooting />
          </DocSection>
        </main>
      </div>
    </div>
  );
}

function DocSection({ id, visible, title, eyebrow, children }: { id: string; visible: boolean; title?: string; eyebrow?: string; children: React.ReactNode }) {
  if (!visible) return null;
  return (
    <section id={`help-${id}`} className="scroll-mt-28 border-b border-subtle py-10 first:pt-0 last:border-0" data-help-section={id}>
      {eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>}
      {title && <h2 className="mt-2 text-2xl font-semibold tracking-tight text-primary sm:text-3xl">{title}</h2>}
      <div className="mt-4 text-secondary [&_.doc-lead]:max-w-3xl [&_.doc-lead]:text-base [&_.doc-lead]:leading-7">{children}</div>
    </section>
  );
}

function StepCard({ number, title, text, icon, onClick }: { number: string; title: string; text: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group rounded-2xl border border-subtle bg-surface-raised p-5 text-left transition hover:border-accent hover:shadow-card">
      <div className="flex items-center justify-between"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">{icon}</span><span className="text-sm font-semibold text-muted">{number.padStart(2, '0')}</span></div>
      <h3 className="mt-4 font-semibold text-primary group-hover:text-accent">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-secondary">{text}</p>
    </button>
  );
}

function Screenshot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="mt-6 overflow-hidden rounded-2xl border border-subtle bg-surface-raised shadow-card">
      <img src={src} alt={alt} loading="lazy" className="aspect-video w-full object-cover object-top" />
      <figcaption className="border-t border-subtle px-4 py-3 text-sm text-secondary">{caption}</figcaption>
    </figure>
  );
}

function WorkflowCard({ icon, title, output }: { icon: React.ReactNode; title: string; output: string }) {
  return <div className="rounded-2xl border border-subtle bg-surface-raised p-4"><div className="text-accent [&_svg]:h-5 [&_svg]:w-5">{icon}</div><h3 className="mt-3 font-semibold text-primary">{title}</h3><p className="mt-1 text-xs text-secondary">Output: {output}</p></div>;
}

function FeatureGrid({ items }: { items: Array<[string, string]> }) {
  return <div className="mt-6 grid gap-4 sm:grid-cols-2">{items.map(([title, text]) => <div key={title} className="rounded-2xl border border-subtle bg-surface-raised p-4"><h3 className="font-semibold text-primary">{title}</h3><p className="mt-1 text-sm leading-6 text-secondary">{text}</p></div>)}</div>;
}

function Checklist({ items }: { items: string[] }) {
  return <ol className="mt-6 space-y-3">{items.map((item, index) => <li key={item} className="flex gap-3 rounded-xl border border-subtle bg-surface-raised p-4 text-sm leading-6 text-secondary"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{index + 1}</span>{item}</li>)}</ol>;
}

function Tip({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex gap-3 rounded-2xl border border-[var(--accent)]/30 bg-accent-soft/40 p-4 text-sm leading-6 text-secondary"><Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-accent" /><div><strong className="text-primary">Tip. </strong>{children}</div></div>;
}

function InfoCard({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="rounded-2xl border border-subtle bg-surface-raised p-5"><div className="text-accent [&_svg]:h-5 [&_svg]:w-5">{icon}</div><h3 className="mt-3 font-semibold text-primary">{title}</h3><p className="mt-2 text-sm leading-6 text-secondary">{text}</p></div>;
}

function ShortcutTable() {
  const rows = [
    ['Clipboard', 'Ctrl/Cmd+C · X · V', 'Copy, cut, and cascading paste'],
    ['Paste in place', 'Ctrl/Cmd+Shift+V', 'Paste at original world coordinates'],
    ['Selection', 'Ctrl/Cmd+A · Shift+A · Esc', 'Select all, deselect, or clear'],
    ['Duplicate', 'D · Ctrl/Cmd+D', 'Duplicate the selected set'],
    ['Transform', 'T · E · S', 'Move, rotate, or scale gizmo'],
    ['Nudge', 'Arrows · Page Up/Down', 'Move on world axes; Shift coarse, Alt fine'],
    ['Free camera', 'Toggle + WASD', 'Drag to look and walk; double-tap W sprints; Esc exits'],
    ['Frame', 'F · Home', 'Frame selection or all visible objects'],
    ['Visibility', 'H · Alt+H · L', 'Hide selection, show all, or lock'],
    ['History', 'Ctrl/Cmd+Z · Shift+Z', 'Undo or redo Build edits'],
    ['Tools', 'O · G · I · F2 · ?', 'Origin, snap, precision, rename, help'],
  ];
  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-subtle bg-surface-raised">
      <div className="hidden grid-cols-[1fr_1.3fr_2fr] gap-4 border-b border-subtle bg-surface-muted px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted sm:grid"><span>Action</span><span>Keys</span><span>Behavior</span></div>
      {rows.map(([action, keys, behavior]) => <div key={action} className="grid gap-1 border-b border-subtle px-4 py-3 last:border-0 sm:grid-cols-[1fr_1.3fr_2fr] sm:gap-4"><strong className="text-sm text-primary">{action}</strong><kbd className="w-fit rounded-md bg-surface-muted px-2 py-1 text-xs text-accent">{keys}</kbd><span className="text-sm text-secondary">{behavior}</span></div>)}
    </div>
  );
}

function Troubleshooting() {
  const items = [
    ['A panorama looks stretched', 'Use a true 2:1 equirectangular image. Re-export or crop the source before alignment.'],
    ['Clipboard paste does nothing', 'Keep the app focused and allow clipboard access. Continuity Stage falls back to its in-app clipboard when browser access is blocked.'],
    ['MP4 export is unavailable', 'Use a current Chromium browser with WebCodecs for Render MP4. Quick Preview falls back to MediaRecorder when available.'],
    ['A Build object will not move', 'Check whether any object in the current selection is locked. Unlock the whole selection before group transforms.'],
    ['An export takes a while', '360 renders, cubemaps, and video frames are generated locally. Reduce optional package contents or camera-move length for faster exports.'],
  ];
  return <div className="mt-6 space-y-3">{items.map(([title, text]) => <details key={title} className="group rounded-xl border border-subtle bg-surface-raised p-4"><summary className="cursor-pointer list-none font-semibold text-primary"><span className="inline-flex items-center gap-2"><Settings2 className="h-4 w-4 text-accent" />{title}</span></summary><p className="mt-3 pl-6 text-sm leading-6 text-secondary">{text}</p></details>)}</div>;
}
