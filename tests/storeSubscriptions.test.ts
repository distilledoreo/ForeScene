import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const selectiveWorkspaceSources = [
  '../src/components/workspaces/BuildWorkspace.tsx',
  '../src/components/workspaces/ReferenceWorkspace.tsx',
  '../src/components/workspaces/ShotsWorkspace.tsx',
  '../src/components/workspaces/ExportWorkspace.tsx',
  '../src/components/common/WorkflowGuidance.tsx',
];

describe('Zustand workspace subscriptions', () => {
  it('uses selectors instead of subscribing mounted workspaces to the entire store', () => {
    for (const path of selectiveWorkspaceSources) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).toContain("import { useShallow } from 'zustand/shallow'");
      expect(source).toContain('useProjectStore(useShallow((state) => ({');
      expect(source).not.toContain('useProjectStore();');
    }

    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('useProjectStore((state) => state.project)');
    expect(app).not.toContain('useProjectStore();');
  });
});
