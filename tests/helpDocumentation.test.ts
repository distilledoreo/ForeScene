import { describe, expect, it } from 'vitest';
import { helpSections } from '../src/components/help/helpCatalog';

const REQUIRED_SECTIONS = [
  'getting-started',
  'app-shell',
  'build',
  'reference',
  'shots',
  'export',
  'pano-viewer',
  'project-files',
  'safety-recovery',
  'guidance',
  'shortcuts',
  'limits',
  'troubleshooting',
] as const;

describe('Help Center documentation catalog', () => {
  it('keeps the complete product-manual section map', () => {
    expect(helpSections.map((section) => section.id)).toEqual(REQUIRED_SECTIONS);
  });

  it('keeps a broad documentation baseline instead of regressing to a sparse overview', () => {
    const topics = helpSections.flatMap((section) => section.topics);
    const controls = topics.flatMap((topic) => topic.controls);

    expect(topics.length).toBeGreaterThanOrEqual(40);
    expect(controls.length).toBeGreaterThanOrEqual(250);
  });

  it('uses unique stable IDs and useful explanations throughout the catalog', () => {
    const sectionIds = helpSections.map((section) => section.id);
    const topicIds = helpSections.flatMap((section) => section.topics.map((topic) => topic.id));

    expect(new Set(sectionIds).size).toBe(sectionIds.length);
    expect(new Set(topicIds).size).toBe(topicIds.length);

    for (const section of helpSections) {
      expect(section.description.trim().length).toBeGreaterThan(20);
      expect(section.topics.length).toBeGreaterThan(0);
      for (const topic of section.topics) {
        expect(topic.summary.trim().length).toBeGreaterThan(20);
        expect(topic.controls.length).toBeGreaterThan(0);
        for (const control of topic.controls) {
          expect(control.label.trim().length).toBeGreaterThan(0);
          expect(control.description.trim().length).toBeGreaterThan(20);
        }
      }
    }
  });

  it('links every primary workspace and the standalone panorama viewer', () => {
    const workspaceDestinations = new Set(helpSections.map((section) => section.workspace).filter(Boolean));
    expect(workspaceDestinations).toEqual(new Set(['build', 'reference', 'shots', 'export']));
    expect(helpSections.some((section) => section.mode === 'panoViewer')).toBe(true);
  });
});
