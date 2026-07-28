import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Boxes,
  Camera,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  FileJson,
  FolderOpen,
  Globe2,
  Keyboard,
  ListTree,
  PackageOpen,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { HelpSection, HelpTopic } from '../help/helpCatalog';
import { helpSections } from '../help/helpCatalog';
import { useAppModeStore } from '../../state/useAppModeStore';
import { useContinuityStore } from '../../state/useContinuityStore';

interface HelpWorkspaceProps {
  onClose: () => void;
}

type FilteredSection = Omit<HelpSection, 'topics'> & {
  topics: Array<Omit<HelpTopic, 'controls'> & { controls: HelpTopic['controls'] }>;
};

const groupOrder: HelpSection['group'][] = ['Start here', 'Workspaces', 'Project & guidance', 'Reference'];

const sectionIcons: Record<string, LucideIcon> = {
  'getting-started': BookOpen,
  'app-shell': SlidersHorizontal,
  build: Boxes,
  reference: Camera,
  shots: Clapperboard,
  export: Upload,
  'pano-viewer': Globe2,
  'project-files': FolderOpen,
  'safety-recovery': ShieldCheck,
  guidance: ListTree,
  shortcuts: Keyboard,
  limits: FileJson,
  troubleshooting: Wrench,
};

const initialExpanded = new Set(
  helpSections.flatMap((section) => section.topics.filter((topic) => topic.defaultOpen).map((topic) => topic.id)),
);

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchesTerms(value: string, terms: string[]): boolean {
  const haystack = normalizeSearch(value);
  return terms.every((term) => haystack.includes(term));
}

function topicSearchText(topic: HelpTopic): string {
  return [
    topic.title,
    topic.summary,
    ...(topic.notes ?? []),
    ...topic.controls.flatMap((control) => [
      control.label,
      control.description,
      ...(control.details ?? []),
      ...(control.keywords ?? []),
    ]),
  ].join(' ');
}

function filterHelpSections(query: string): FilteredSection[] {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return helpSections.map((section) => ({ ...section, topics: [...section.topics] }));

  return helpSections.flatMap((section) => {
    const sectionMatches = matchesTerms(`${section.navLabel} ${section.title} ${section.description}`, terms);
    const topics = section.topics.flatMap((topic) => {
      const topicMatches = sectionMatches || matchesTerms(topicSearchText(topic), terms);
      if (!topicMatches) return [];

      const headingMatches = sectionMatches || matchesTerms(
        `${topic.title} ${topic.summary} ${(topic.notes ?? []).join(' ')}`,
        terms,
      );
      const controls = headingMatches
        ? topic.controls
        : topic.controls.filter((control) => matchesTerms([
          control.label,
          control.description,
          ...(control.details ?? []),
          ...(control.keywords ?? []),
        ].join(' '), terms));

      return [{ ...topic, controls }];
    });

    return topics.length > 0 ? [{ ...section, topics }] : [];
  });
}

export function HelpWorkspace({ onClose }: HelpWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(() => new Set(initialExpanded));
  const setWorkspace = useContinuityStore((state) => state.setWorkspace);
  const setAppMode = useAppModeStore((state) => state.setAppMode);
  const normalizedQuery = normalizeSearch(query);
  const filteredSections = useMemo(() => filterHelpSections(query), [query]);
  const visibleSectionIds = useMemo(() => new Set(filteredSections.map((section) => section.id)), [filteredSections]);
  const visibleTopicIds = useMemo(
    () => filteredSections.flatMap((section) => section.topics.map((topic) => topic.id)),
    [filteredSections],
  );
  const totalControls = useMemo(
    () => filteredSections.reduce(
      (sum, section) => sum + section.topics.reduce((topicSum, topic) => topicSum + topic.controls.length, 0),
      0,
    ),
    [filteredSections],
  );
  const allVisibleExpanded = visibleTopicIds.length > 0 && visibleTopicIds.every((id) => expandedTopics.has(id));

  const jumpTo = (id: string) => {
    document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openSectionDestination = (section: HelpSection) => {
    if (section.workspace) {
      setAppMode('continuity');
      setWorkspace(section.workspace);
    } else if (section.mode === 'panoViewer') {
      setAppMode('panoViewer');
    } else {
      return;
    }
    onClose();
  };

  const toggleTopic = (id: string, open: boolean) => {
    setExpandedTopics((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setExpandedTopics((current) => {
      const next = new Set(current);
      if (allVisibleExpanded) visibleTopicIds.forEach((id) => next.delete(id));
      else visibleTopicIds.forEach((id) => next.add(id));
      return next;
    });
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-base pt-[7.25rem] md:pt-[5.5rem]" data-help-workspace>
      <div className="mx-auto grid w-full max-w-[1600px] gap-7 px-4 pb-20 md:grid-cols-[270px_minmax(0,1fr)] md:px-8 lg:gap-12">
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
              placeholder="Search every feature"
              aria-label="Search documentation"
              className="h-11 w-full rounded-xl border border-subtle bg-surface-raised pl-9 pr-3 text-sm text-primary outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-[var(--accent-glow)]"
              data-help-search
            />
          </label>

          <div className="mt-2 flex items-center justify-between px-1 text-xs text-muted">
            <span>{normalizedQuery ? `${totalControls} matching controls` : `${totalControls} documented controls`}</span>
            {normalizedQuery && (
              <button type="button" onClick={() => setQuery('')} className="font-medium text-accent hover:underline">
                Clear
              </button>
            )}
          </div>

          <select
            aria-label="Documentation section"
            className="mt-3 h-11 w-full rounded-xl border border-subtle bg-surface-raised px-3 text-sm text-primary md:hidden"
            onChange={(event) => jumpTo(event.target.value)}
            defaultValue="getting-started"
          >
            {groupOrder.map((group) => (
              <optgroup key={group} label={group}>
                {helpSections.filter((section) => section.group === group).map((section) => (
                  <option key={section.id} value={section.id}>{section.navLabel}</option>
                ))}
              </optgroup>
            ))}
          </select>

          <nav className="mt-6 hidden space-y-6 md:block" aria-label="Documentation navigation">
            {groupOrder.map((group) => (
              <div key={group}>
                <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{group}</div>
                <div className="space-y-0.5">
                  {helpSections.filter((section) => section.group === group).map((section) => {
                    const Icon = sectionIcons[section.id] ?? BookOpen;
                    const visible = visibleSectionIds.has(section.id);
                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => visible && jumpTo(section.id)}
                        disabled={!visible}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                          visible
                            ? 'text-secondary hover:bg-surface-muted hover:text-primary'
                            : 'cursor-not-allowed text-muted opacity-30'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{section.navLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <section className="overflow-hidden rounded-[28px] border border-subtle bg-gradient-to-br from-surface-raised via-surface-raised to-accent-soft p-6 shadow-card sm:p-10">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="max-w-4xl">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-white shadow-[0_0_28px_var(--accent-glow)]">
                  <BookOpen className="h-6 w-6" />
                </div>
                <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-accent">Complete product manual</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-primary sm:text-5xl">Every workspace. Every control. One searchable Help Center.</h1>
                <p className="mt-5 max-w-3xl text-base leading-7 text-secondary sm:text-lg">
                  Start with a task, search the exact label you see in the app, or browse the expandable control reference. Advanced settings stay collapsed until you need them. Search examples include Projected Style, Near Clip, and double-tap W.
                </p>
              </div>
              <div className="rounded-2xl border border-subtle bg-surface-overlay/80 px-4 py-3 text-sm shadow-card backdrop-blur">
                <div className="font-semibold text-primary">Documentation coverage</div>
                <div className="mt-1 text-secondary">{helpSections.length} sections · {helpSections.reduce((sum, section) => sum + section.topics.length, 0)} feature groups</div>
              </div>
            </div>

            <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <QuickLink icon={Boxes} title="Block the set" subtitle="Build tools and imports" onClick={() => jumpTo('build')} />
              <QuickLink icon={Camera} title="Align references" subtitle="Panos and projection" onClick={() => jumpTo('reference')} />
              <QuickLink icon={Clapperboard} title="Author shots" subtitle="Stills, motion, staging" onClick={() => jumpTo('shots')} />
              <QuickLink icon={PackageOpen} title="Build a package" subtitle="Export every deliverable" onClick={() => jumpTo('export')} />
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2" data-help-visual-overview>
              <figure className="overflow-hidden rounded-2xl border border-subtle bg-surface-overlay/80 shadow-card">
                <img
                  src="/docs/workflow-overview.png"
                  alt="Continuity Stage workflow overview from Build through Export"
                  className="aspect-video w-full object-cover"
                />
                <figcaption className="px-4 py-3 text-sm text-secondary">
                  The four-stage production path and the information handed from one workspace to the next.
                </figcaption>
              </figure>
              <figure className="overflow-hidden rounded-2xl border border-subtle bg-surface-overlay/80 shadow-card">
                <img
                  src="/docs/build-workspace.png"
                  alt="Annotated Build workspace orientation"
                  className="aspect-video w-full object-cover"
                />
                <figcaption className="px-4 py-3 text-sm text-secondary">
                  Build workspace orientation before opening the complete control-by-control reference below.
                </figcaption>
              </figure>
            </div>
          </section>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-subtle bg-surface-raised px-4 py-3">
            <p className="text-sm text-secondary">
              {normalizedQuery
                ? `Showing ${filteredSections.length} sections and ${totalControls} matching controls for “${query}”.`
                : 'Topics are collapsed to keep the manual scannable. Expand only the feature group you need.'}
            </p>
            <button
              type="button"
              onClick={toggleAllVisible}
              disabled={visibleTopicIds.length === 0}
              className="rounded-lg border border-subtle px-3 py-2 text-xs font-semibold text-secondary transition hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {allVisibleExpanded ? 'Collapse visible topics' : 'Expand visible topics'}
            </button>
          </div>

          {filteredSections.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-subtle bg-surface-raised p-10 text-center">
              <Search className="mx-auto h-9 w-9 text-muted" />
              <h2 className="mt-3 text-xl font-semibold text-primary">No documentation matched “{query}”</h2>
              <p className="mt-2 text-sm text-secondary">Try a visible label such as “near clip,” “clean plate,” “coverage optimizer,” “snapshot,” or “paste in place.”</p>
            </div>
          ) : (
            <div className="mt-2">
              {filteredSections.map((section) => (
                <HelpSectionBlock
                  key={section.id}
                  section={section}
                  forceOpen={Boolean(normalizedQuery)}
                  expandedTopics={expandedTopics}
                  onToggleTopic={toggleTopic}
                  onOpenDestination={() => openSectionDestination(section)}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function QuickLink({ icon: Icon, title, subtitle, onClick }: { icon: LucideIcon; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group rounded-2xl border border-subtle bg-surface-overlay/80 p-4 text-left transition hover:border-accent hover:shadow-card">
      <Icon className="h-5 w-5 text-accent" />
      <div className="mt-3 font-semibold text-primary group-hover:text-accent">{title}</div>
      <div className="mt-1 text-xs text-secondary">{subtitle}</div>
    </button>
  );
}

function HelpSectionBlock({
  section,
  forceOpen,
  expandedTopics,
  onToggleTopic,
  onOpenDestination,
}: {
  section: FilteredSection;
  forceOpen: boolean;
  expandedTopics: Set<string>;
  onToggleTopic: (id: string, open: boolean) => void;
  onOpenDestination: () => void;
}) {
  const Icon = sectionIcons[section.id] ?? BookOpen;
  const controlCount = section.topics.reduce((sum, topic) => sum + topic.controls.length, 0);
  const hasDestination = Boolean(section.workspace || section.mode);

  return (
    <section id={`help-${section.id}`} className="scroll-mt-28 border-b border-subtle py-10 last:border-0" data-help-section={section.id}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-4xl">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Icon className="h-5 w-5" /></span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{section.group}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-primary sm:text-3xl">{section.title}</h2>
            </div>
          </div>
          <p className="mt-4 max-w-3xl text-base leading-7 text-secondary">{section.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-subtle bg-surface-raised px-3 py-1.5 text-xs text-muted">{controlCount} controls</span>
          {hasDestination && (
            <button type="button" onClick={onOpenDestination} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[var(--accent-hover)]">
              Open {section.navLabel}
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-3">
        {section.topics.map((topic) => {
          const open = forceOpen || expandedTopics.has(topic.id);
          return (
            <details
              key={topic.id}
              open={open}
              onToggle={(event) => {
                if (!forceOpen) onToggleTopic(topic.id, event.currentTarget.open);
              }}
              className="group overflow-hidden rounded-2xl border border-subtle bg-surface-raised shadow-sm"
              data-help-topic={topic.id}
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4 transition hover:bg-surface-muted/70">
                <div>
                  <h3 className="font-semibold text-primary">{topic.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-secondary">{topic.summary}</p>
                </div>
                <span className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted">
                  {topic.controls.length}
                  <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
                </span>
              </summary>
              <div className="border-t border-subtle px-5 py-5">
                <div className="grid gap-3 lg:grid-cols-2">
                  {topic.controls.map((control) => (
                    <article key={`${topic.id}-${control.label}`} className="rounded-xl border border-subtle bg-surface-base p-4" data-help-control={control.label}>
                      <h4 className="text-sm font-semibold text-primary">{control.label}</h4>
                      <p className="mt-1.5 text-sm leading-6 text-secondary">{control.description}</p>
                      {control.details && control.details.length > 0 && (
                        <ul className="mt-3 space-y-1.5 text-xs leading-5 text-secondary">
                          {control.details.map((detail) => (
                            <li key={detail} className="flex gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />{detail}</li>
                          ))}
                        </ul>
                      )}
                    </article>
                  ))}
                </div>
                {topic.notes && topic.notes.length > 0 && (
                  <div className="mt-4 rounded-xl border border-[var(--accent)]/30 bg-accent-soft/40 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-accent">Important behavior</div>
                    <ul className="mt-2 space-y-2 text-sm leading-6 text-secondary">
                      {topic.notes.map((note) => <li key={note}>• {note}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
