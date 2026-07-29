import React, { useEffect, useRef } from 'react';
import type { LassoPoint } from '../../engine/autorig/regionSelection';

/**
 * Lightweight 2D lasso path overlay. Updates immediately with pointer movement;
 * region calculations run only after pointer release (parent owns that).
 */
export function AutorigLassoOverlay({
  width,
  height,
  points,
  drawing,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  width: number;
  height: number;
  points: ReadonlyArray<LassoPoint>;
  drawing: boolean;
  className?: string;
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (points.length < 2) return;
    ctx.strokeStyle = drawing ? 'rgba(255, 255, 255, 0.95)' : 'rgba(148, 163, 184, 0.85)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(drawing ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i]!.x, points[i]!.y);
    }
    if (!drawing && points.length >= 3) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fill();
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }, [points, drawing, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className}
      data-autorig-lasso-canvas
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
  );
}
