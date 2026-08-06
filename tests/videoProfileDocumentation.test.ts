import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { helpCatalogText } from '../src/components/help/helpCatalog';

const exportSettingsSource = readFileSync(
  new URL('../src/components/export/ExportSettingsPanel.tsx', import.meta.url),
  'utf8',
);

describe('video profile documentation', () => {
  it('describes each profile with its actual resolution and frame rate', () => {
    expect(exportSettingsSource).toContain(
      'Standard uses 1080p30 and High Quality uses 4K30.',
    );
    expect(exportSettingsSource).not.toContain(
      'Standard and High Quality keep 1080p30.',
    );

    const helpText = helpCatalogText();
    expect(helpText).toContain(
      'Fast Control 720p24, Standard 1080p30, High Quality 4K30',
    );
    expect(helpText).not.toContain(
      'Fast Control 720p24, Standard/High Quality 1080p30',
    );
  });
});
