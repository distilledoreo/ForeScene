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

const REQUIRED_CONTROLS_BY_SECTION: Record<string, readonly string[]> = {
  'getting-started': [
    'Skip intro',
    'Build continuity packages',
    'Just view a 360 pano',
    'Save status',
    'Verified saves',
  ],
  'app-shell': [
    'Project name',
    'Current Objective',
    'New Project',
    'Import Project Backup',
    'Project Safety & Recovery',
    'Export Project Backup',
    'Package Export',
    'Theme button',
    'Save-status indicator',
  ],
  build: [
    'Free camera',
    'Visibility distance',
    'Scene guides',
    'Primitive buttons',
    'Import 3D model or scene',
    'Keep objects separate',
    'Combine into one object',
    'Allow heavy imports',
    'Precision drawer (I)',
    'Move (T)',
    'Rotate (E)',
    'Scale (S)',
    'Cut / Copy / Paste',
    'Staging role',
    'Surface',
    'Capture origin',
    'Render 360 Reference',
    'Download Projected 360',
  ],
  reference: [
    'Import styled pano',
    'Use graybox only (skip styling)',
    'Yaw',
    'Graybox fade / compare opacity',
    'Fill missing areas…',
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
    'Search strategy',
    'Analyze panorama origins',
    'Move capture origin to A / B',
    'Landmark markers',
  ],
  shots: [
    'Still / Video',
    'Clay / Projected',
    'Hide people / Show people',
    'Capture',
    'Capture start',
    'Capture next',
    'Finish capture',
    'Continue sequence',
    'Retake move',
    'Stage / Per-shot staging',
    'Copy staging → next',
    'Hide in shot / Show in shot',
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
    'Pano match',
    'Edit timeline',
    'Update pose',
    'Insert here',
    'Motion easing',
    'Shot thumbnail',
    'Delete shot',
    'Export mode',
    'Video resolution',
    'Export MP4',
  ],
  export: [
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
    'Export Final ZIP (current shot)',
    'Add Camera',
    'Export Selected Shots',
    'Manifest preview',
    'Cancel export',
  ],
  'pano-viewer': [
    'Import pano',
    'Replace pano',
    'FOV / Field of view',
    'Download current view',
  ],
  'project-files': [
    'Import Project Backup',
    'Export Project Backup',
    'Project backup',
    'Continuity ZIP package',
    'Local media',
  ],
  'safety-recovery': [
    'Snapshot reason',
    'Snapshot',
    'Recovery point filters',
    'Restore',
    'Persistent storage',
    'Export backup',
    'Free temporary data',
    'Largest assets',
    'Open local history',
    'Remove local history',
    'Scan again',
    'Repair safe issues',
  ],
  guidance: [
    'Show current objective',
    'Ready for the next step / Continue',
    'Start checking',
    'Your scene idea',
    'Copy prompt',
    'Download 16:9 graybox / graybox PNG',
  ],
  shortcuts: [
    'Ctrl/Cmd+C · X · V',
    'Ctrl/Cmd+Shift+V',
    'T · E · S',
    'WASD',
    'Double-tap W',
    'Escape',
  ],
  limits: [
    'Render MP4',
    'Quick Preview',
    'WebKit',
    'Heavy imports',
    'Storage pressure warnings',
  ],
  troubleshooting: [
    'Panorama looks stretched',
    'Projected areas look thin or wrong',
    'Import fails',
    'MP4 export is unavailable',
    'Local save failed',
    'Missing media after restart',
  ],
};

describe('Help Center documentation catalog', () => {
  it('keeps a broad, structured product-manual baseline', () => {
    const topics = helpSections.flatMap((section) => section.topics);
    const controls = topics.flatMap((topic) => topic.controls);

    expect(helpSections.length).toBeGreaterThanOrEqual(13);
    expect(topics.length).toBeGreaterThanOrEqual(40);
    expect(controls.length).toBeGreaterThanOrEqual(250);
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

  it('retains every required documentation section', () => {
    const sectionIds = new Set(helpSections.map((section) => section.id));
    for (const required of REQUIRED_SECTIONS) expect(sectionIds.has(required)).toBe(true);
  });

  it('retains the known user-facing control inventory inside the correct owning sections', () => {
    for (const [sectionId, requiredLabels] of Object.entries(REQUIRED_CONTROLS_BY_SECTION)) {
      const section = helpSections.find((item) => item.id === sectionId);
      expect(section, `Missing Help section: ${sectionId}`).toBeTruthy();
      const labels = new Set(section!.topics.flatMap((topic) => topic.controls.map((control) => control.label)));
      const missing = requiredLabels.filter((label) => !labels.has(label));
      expect(missing, `Missing controls in ${sectionId}`).toEqual([]);
    }
  });

  it('links every primary app mode or production workspace from the catalog', () => {
    const workspaceDestinations = new Set(helpSections.map((section) => section.workspace).filter(Boolean));
    expect(workspaceDestinations).toEqual(new Set(['build', 'reference', 'shots', 'export']));
    expect(helpSections.some((section) => section.mode === 'panoViewer')).toBe(true);
  });
});
