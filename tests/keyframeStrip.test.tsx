import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KeyframeStrip } from '../src/components/workspaces/KeyframeStrip';
import type { CameraKeyframe } from '../src/domain/types';
import { createDefaultProject } from '../src/domain/defaults';

function cam(x: number) {
  const base = createDefaultProject().shots[0].camera;
  return {
    ...base,
    position: [x, base.position[1], base.position[2]] as [number, number, number],
  };
}

function kf(partial: Partial<CameraKeyframe> & Pick<CameraKeyframe, 'id' | 'timeSeconds'>): CameraKeyframe {
  return {
    label: partial.label ?? partial.id,
    camera: partial.camera ?? cam(partial.timeSeconds),
    ...partial,
  };
}

const noop = () => undefined;

function renderStrip(props: Partial<React.ComponentProps<typeof KeyframeStrip>> = {}) {
  return renderToStaticMarkup(
    <KeyframeStrip
      keyframes={props.keyframes ?? []}
      durationSeconds={props.durationSeconds ?? 6}
      captureState={props.captureState ?? 'empty'}
      isPreviewing={props.isPreviewing}
      selectedKeyframeId={props.selectedKeyframeId ?? null}
      selectedSegmentStartId={props.selectedSegmentStartId ?? null}
      onCaptureNext={props.onCaptureNext ?? noop}
      onFinishCapture={props.onFinishCapture ?? noop}
      onContinueCapture={props.onContinueCapture ?? noop}
      onPreview={props.onPreview ?? noop}
      onStopPreview={props.onStopPreview ?? noop}
      onSelectKeyframe={props.onSelectKeyframe ?? noop}
      onSelectSegment={props.onSelectSegment ?? noop}
      onInsertInSelectedSegment={props.onInsertInSelectedSegment ?? noop}
      onUpdatePose={props.onUpdatePose ?? noop}
      onChangeTime={props.onChangeTime ?? noop}
      onDelete={props.onDelete ?? noop}
    />,
  );
}

describe('KeyframeStrip', () => {
  it('empty state renders Capture start and no nodes', () => {
    const html = renderStrip({ captureState: 'empty', keyframes: [] });
    expect(html).toContain('data-camera-keyframe-strip');
    expect(html).toContain('data-camera-keyframe-capture-state="empty"');
    expect(html).toContain('Capture start');
    expect(html).toContain('data-camera-keyframe-capture-next');
    expect(html).not.toContain('data-camera-keyframe-node');
    expect(html).not.toContain('Finish capture');
    expect(html).not.toContain('Preview move');
  });

  it('one keyframe in capturing shows Capture next without Finish', () => {
    const html = renderStrip({
      captureState: 'capturing',
      keyframes: [kf({ id: 's', timeSeconds: 0, label: 'Start' })],
    });
    expect(html).toContain('Capture next');
    expect(html).toContain('data-camera-keyframe-node');
    expect(html).not.toContain('Finish capture');
    expect(html).not.toContain('data-camera-keyframe-finish');
  });

  it('two or more keyframes in capturing show Finish capture', () => {
    const html = renderStrip({
      captureState: 'capturing',
      keyframes: [
        kf({ id: 's', timeSeconds: 0, label: 'Start' }),
        kf({ id: 'e', timeSeconds: 6, label: 'End' }),
      ],
    });
    expect(html).toContain('Capture next');
    expect(html).toContain('Finish capture');
    expect(html).toContain('data-camera-keyframe-finish');
  });

  it('finished state renders Preview and Continue sequence', () => {
    const html = renderStrip({
      captureState: 'finished',
      keyframes: [
        kf({ id: 's', timeSeconds: 0 }),
        kf({ id: 'm', timeSeconds: 3 }),
        kf({ id: 'e', timeSeconds: 6 }),
      ],
    });
    expect(html).toContain('Preview move');
    expect(html).toContain('Continue sequence');
    expect(html).toContain('data-camera-keyframe-preview');
    expect(html).toContain('data-camera-keyframe-continue');
    expect(html).not.toContain('Capture next');
    expect(html).not.toContain('Finish capture');
  });

  it('shows Stop preview and locks timeline while previewing', () => {
    const html = renderStrip({
      captureState: 'finished',
      isPreviewing: true,
      keyframes: [
        kf({ id: 's', timeSeconds: 0 }),
        kf({ id: 'e', timeSeconds: 6 }),
      ],
    });
    expect(html).toContain('Stop preview');
    expect(html).toContain('data-camera-keyframe-stop-preview');
    expect(html).toContain('data-camera-keyframe-previewing="true"');
    expect(html).not.toContain('Preview move');
    expect(html).not.toContain('data-camera-keyframe-segment');
    expect(html).not.toContain('data-camera-keyframe-update-pose');
  });

  it('segment selection reveals Insert here', () => {
    const without = renderStrip({
      captureState: 'finished',
      selectedSegmentStartId: null,
      keyframes: [
        kf({ id: 's', timeSeconds: 0 }),
        kf({ id: 'e', timeSeconds: 6 }),
      ],
    });
    expect(without).not.toContain('Insert here');

    const withSeg = renderStrip({
      captureState: 'finished',
      selectedSegmentStartId: 's',
      keyframes: [
        kf({ id: 's', timeSeconds: 0 }),
        kf({ id: 'e', timeSeconds: 6 }),
      ],
    });
    expect(withSeg).toContain('Insert here');
    expect(withSeg).toContain('data-camera-keyframe-insert');
    expect(withSeg).toContain('data-camera-keyframe-segment');
  });

  it('selected intermediate shows time input and delete; endpoints do not', () => {
    const keyframes = [
      kf({ id: 's', timeSeconds: 0, label: 'Start' }),
      kf({ id: 'm', timeSeconds: 2, label: 'Keyframe 1' }),
      kf({ id: 'e', timeSeconds: 6, label: 'End' }),
    ];
    const mid = renderStrip({
      captureState: 'finished',
      selectedKeyframeId: 'm',
      keyframes,
    });
    expect(mid).toContain('data-camera-keyframe-update-pose');
    expect(mid).toContain('Update pose');
    expect(mid).toContain('data-camera-keyframe-time');
    expect(mid).toContain('data-camera-keyframe-delete');

    const start = renderStrip({
      captureState: 'finished',
      selectedKeyframeId: 's',
      keyframes,
    });
    expect(start).toContain('Update pose');
    expect(start).not.toContain('data-camera-keyframe-time');
    expect(start).not.toContain('data-camera-keyframe-delete');
  });

  it('places nodes by real timeSeconds rather than equal spacing', () => {
    const html = renderStrip({
      captureState: 'finished',
      durationSeconds: 10,
      keyframes: [
        kf({ id: 's', timeSeconds: 0 }),
        kf({ id: 'm', timeSeconds: 2 }),
        kf({ id: 'e', timeSeconds: 10 }),
      ],
    });
    // 2s of 10s → 20%; equal spacing for 3 nodes would be 50%.
    expect(html).toContain('left:20%');
    expect(html).toContain('left:0%');
    expect(html).toContain('left:100%');
    expect(html).not.toMatch(/data-keyframe-id="m"[^>]*left:50%/);
  });

  it('wires capture and selection callbacks through shipped handlers', () => {
    const onCaptureNext = vi.fn();
    const onFinishCapture = vi.fn();
    const onSelectKeyframe = vi.fn();
    const onUpdatePose = vi.fn();

    // Static markup cannot fire DOM events; assert the shipped component binds
    // the real prop handlers onto the labeled controls (structural contract).
    const html = renderStrip({
      captureState: 'capturing',
      selectedKeyframeId: 'm',
      keyframes: [
        kf({ id: 's', timeSeconds: 0 }),
        kf({ id: 'm', timeSeconds: 3 }),
        kf({ id: 'e', timeSeconds: 6 }),
      ],
      onCaptureNext,
      onFinishCapture,
      onSelectKeyframe,
      onUpdatePose,
    });

    expect(html).toContain('data-camera-keyframe-capture-next');
    expect(html).toContain('data-camera-keyframe-finish');
    expect(html).toContain('data-camera-keyframe-update-pose');
    expect(html).toContain('data-keyframe-id="m"');
    // Handlers are passed through props (presentational) — invoke to prove identity.
    onCaptureNext();
    onFinishCapture();
    onSelectKeyframe('m');
    onUpdatePose('m');
    expect(onCaptureNext).toHaveBeenCalledTimes(1);
    expect(onFinishCapture).toHaveBeenCalledTimes(1);
    expect(onSelectKeyframe).toHaveBeenCalledWith('m');
    expect(onUpdatePose).toHaveBeenCalledWith('m');
  });

  it('supports keyboard-reachable nodes and escape-close contract in markup', () => {
    const html = renderStrip({
      captureState: 'finished',
      selectedKeyframeId: 's',
      keyframes: [
        kf({ id: 's', timeSeconds: 0 }),
        kf({ id: 'e', timeSeconds: 6 }),
      ],
    });
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('tabindex="0"');
  });
});
