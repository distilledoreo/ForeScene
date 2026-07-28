import { describe, expect, it } from 'vitest';
import { helpCatalogText, helpSections } from '../src/components/help/helpCatalog';

const REQUIRED_DOCUMENTATION_TERMS = [
  // App shell and project actions
  'Build continuity packages',
  'Just view a 360 pano',
  'Project name',
  'Current Objective',
  'New Project',
  'Import Project Backup',
  'Project Safety & Recovery',
  'Export Project Backup',
  'Package Export',
  'Theme button',
  'Save-status indicator',

  // Build
  'Free camera',
  'Visibility distance',
  'Scene guides',
  'Primitive buttons',
  'Import 3D model or scene',
  'Keep objects separate',
  'Combine into one object',
  'Allow heavy imports',
  'Precision drawer',
  'Scene layers',
  'Move (T)',
  'Rotate (E)',
  'Scale (S)',
  'Paste in place',
  'Staging role',
  'Person / character',
  '1 m × 1 m checkerboard',
  'Capture origin',
  'Render 360 Reference',
  'Download Projected 360',

  // Reference
  'Import styled pano',
  'Use graybox only',
  'Graybox fade',
  'Yaw',
  'Fill missing areas',
  'Letterbox panorama exports to 16:9',
  'Primary panorama',
  'Multi-origin blend',
  'Secondary panorama',
  'Geometry occlusion',
  'Ownership preview',
  'Occlusion bias',
  'Edge softness',
  'Lighting contribution',
  'Unsupported-area fallback',
  'Coverage optimizer',
  'Search strategy',
  'X/Y/Z minimum and maximum',
  'Move capture origin to A / B',
  'Landmarks',

  // Shots
  'Still / Video',
  'Clay / Projected',
  'Hide people / Show people',
  'Capture start',
  'Capture next',
  'Finish capture',
  'Continue sequence',
  'Retake move',
  'Copy staging → next',
  'Hide in shot / Show in shot',
  'Reset to set',
  'Production shot ID',
  'People export',
  'Camera Position',
  'Camera Target / Look-at target',
  'Vertical FOV',
  'Focal length',
  'Near Clip',
  'Far Clip',
  'Shot-to-shot continuity',
  'Previous shot overlay',
  'Sequence storyboard',
  'Play animatic / Stop animatic',
  'Pano match',
  'Edit timeline',
  'Update pose',
  'Insert here',
  'Motion easing',
  'Shot thumbnail',
  'Duplicate',
  'Delete shot',
  'Export mode',
  'Render MP4',
  'Quick Preview',
  'Video resolution',

  // Export
  'Select Shots to Export',
  'Package readiness',
  'Width / Height',
  'People output',
  'Viewport clay render',
  'Viewport projected render',
  'AI result frame',
  'Pano crop',
  'Styled reference pano',
  'Graybox pano',
  'Camera move clay MP4',
  'Camera move projected MP4',
  'Camera move clay frames',
  'Camera move projected frames',
  'Metadata JSON',
  'Prompts',
  'Export Final ZIP',
  'Add Camera',
  'Export Selected Shots',
  'Manifest preview',
  'Cancel export',

  // Viewer, persistence, safety, and guidance
  'Replace pano',
  'Download current view',
  'Verified saves',
  'Recovery point filters',
  'Snapshot reason',
  'Persistent storage',
  'Free temporary data',
  'Largest assets',
  'Open local history',
  'Remove local history',
  'Scan again',
  'Repair safe issues',
  'Your scene idea',
  'Copy prompt',
  'Download 16:9 graybox',

  // Compatibility and troubleshooting
  'Ctrl/Cmd+Shift+V',
  'Double-tap W',
  'WebCodecs',
  'Storage pressure warnings',
  'Panorama looks stretched',
  'Projected areas look thin or wrong',
  'Local save failed',
] as const;

describe('Help Center documentation catalog', () => {
  it('keeps a broad, structured product-manual baseline', () => {
    const topics = helpSections.flatMap((section) => section.topics);
    const controls = topics.flatMap((topic) => topic.controls);

    expect(helpSections.length).toBeGreaterThanOrEqual(12);
    expect(topics.length).toBeGreaterThanOrEqual(35);
    expect(controls.length).toBeGreaterThanOrEqual(175);
  });

  it('uses unique section and topic IDs for stable navigation', () => {
    const sectionIds = helpSections.map((section) => section.id);
    const topicIds = helpSections.flatMap((section) => section.topics.map((topic) => topic.id));

    expect(new Set(sectionIds).size).toBe(sectionIds.length);
    expect(new Set(topicIds).size).toBe(topicIds.length);
  });

  it('gives every documented control a useful explanation', () => {
    for (const section of helpSections) {
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.description.trim().length).toBeGreaterThan(20);
      expect(section.topics.length).toBeGreaterThan(0);

      for (const topic of section.topics) {
        expect(topic.summary.trim().length).toBeGreaterThan(20);
        expect(topic.controls.length).toBeGreaterThan(0);

        const labels = topic.controls.map((control) => control.label);
        expect(new Set(labels).size).toBe(labels.length);

        for (const control of topic.controls) {
          expect(control.label.trim().length).toBeGreaterThan(0);
          expect(control.description.trim().length).toBeGreaterThan(20);
        }
      }
    }
  });

  it('documents the known user-facing feature and control inventory', () => {
    const catalog = helpCatalogText().toLocaleLowerCase();
    const missing = REQUIRED_DOCUMENTATION_TERMS.filter((term) => !catalog.includes(term.toLocaleLowerCase()));
    expect(missing).toEqual([]);
  });

  it('links every primary app mode or production workspace from the catalog', () => {
    const workspaceDestinations = new Set(helpSections.map((section) => section.workspace).filter(Boolean));
    expect(workspaceDestinations).toEqual(new Set(['build', 'reference', 'shots', 'export']));
    expect(helpSections.some((section) => section.mode === 'panoViewer')).toBe(true);
  });
});
