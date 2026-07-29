import React, { useEffect, useRef } from 'react';
import type { BrushStrokePoint } from '../../engine/autorig/regionSelection';
import { regionColorCss } from '../../engine/autorig/regionOverlay';
import type { AutorigBodyRegionId } from '../../engine/autorig/regions';

/**
 * Circular brush cursor + translucent stroke trail for posed painting.
 * Region calculations run only after pointer release (parent owns that).
 */
export function AutorigBrushOverlay({
  width,
  height,
  stroke,
  drawing,
  cursor,
  radius,
  region,
  restoreAutomatic,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onWheel,
}: {
  width: number;
  height: number;
  stroke: ReadonlyArray<BrushStrokePoint>;
  drawing: boolean;
  cursor: { x: number; y: number } | null;
  radius: number;
  region: AutorigBodyRegionId;
  restoreAutomatic?: boolean;
  className?: string;
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onWheel?: (event: React.WheelEvent<HTMLCanvasElement>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const color = restoreAutomatic ? 'rgba(226, 232, 240, 0.9)' : regionColorCss(region);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    if (stroke.length > 0) {
      ctx.strokeStyle = color;
      ctx.fillStyle = restoreAutomatic ? 'rgba(226, 232, 240, 0.18)' : 'rgba(56, 189, 248, 0.18)';
      // Approximate trail as overlapping disks.
      for (const point of stroke) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      if (stroke.length >= 2) {
        ctx.lineWidth = Math.max(2, radius * 0.35);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
        for (let i = 1; i < stroke.length; i += 1) {
          ctx.lineTo(stroke[i]!.x, stroke[i]!.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    if (cursor) {
      ctx.beginPath();
      ctx.strokeStyle = drawing ? '#fff' : color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(drawing ? [] : [4, 3]);
      ctx.arc(cursor.x, cursor.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.arc(cursor.x, cursor.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [stroke, drawing, cursor, radius, color, restoreAutomatic, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className}
      data-autorig-brush-canvas
      style={{ cursor: 'none' }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onWheel={onWheel}
    />
  );
}
