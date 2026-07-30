import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { ShotMediaModal } from '../src/components/common/ShotMediaModal';

describe('shot metadata editing', () => {
  it('exposes production ID and title fields in the media modal', () => {
    const project = createDefaultProject();
    const shot = {
      ...project.shots[0],
      productionShotId: '42A',
      name: 'Courtyard entrance',
    };
    project.shots[0] = shot;

    const html = renderToStaticMarkup(
      <ShotMediaModal
        open
        project={project}
        shots={project.shots}
        shotId={shot.id}
        onClose={() => undefined}
        onOpenShot={() => undefined}
        onUpdateShot={() => undefined}
      />,
    );

    expect(html).toContain('Production ID');
    expect(html).toContain('Shot title');
    expect(html).toContain('42A · Courtyard entrance');
    expect(html).toContain('ForeScene shot');
  });

  it('shows only the production ID until a custom title is set', () => {
    const project = createDefaultProject();
    const shot = {
      ...project.shots[0],
      productionShotId: '42A',
      name: 'Camera 001',
    };
    project.shots[0] = shot;

    const html = renderToStaticMarkup(
      <ShotMediaModal
        open
        project={project}
        shots={project.shots}
        shotId={shot.id}
        onClose={() => undefined}
        onOpenShot={() => undefined}
        onUpdateShot={() => undefined}
      />,
    );

    expect(html).toContain('>42A<');
    expect(html).not.toContain('42A · Camera 001');
  });
});
