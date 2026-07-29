import { useCallback, useRef, useState } from 'react';
import type { BrushStrokePoint } from '../../../engine/autorig/regionSelection';

const DEFAULT_BRUSH_RADIUS = 36;
const MIN_BRUSH_RADIUS = 10;
const MAX_BRUSH_RADIUS = 80;

export function clampBrushRadius(value: number): number {
  return Math.min(MAX_BRUSH_RADIUS, Math.max(MIN_BRUSH_RADIUS, value));
}

/** Brush stroke capture + radius controls for Pose & Fix painting. */
export function useAutorigPaintSession(initialRadius = DEFAULT_BRUSH_RADIUS) {
  const [brushRadius, setBrushRadiusState] = useState(() => clampBrushRadius(initialRadius));
  const [stroke, setStroke] = useState<BrushStrokePoint[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const strokeRef = useRef<BrushStrokePoint[]>([]);
  const radiusRef = useRef(brushRadius);
  radiusRef.current = brushRadius;

  const setBrushRadius = useCallback((value: number) => {
    const next = clampBrushRadius(value);
    setBrushRadiusState(next);
    radiusRef.current = next;
  }, []);

  const nudgeBrushRadius = useCallback((delta: number) => {
    setBrushRadius(radiusRef.current + delta);
  }, [setBrushRadius]);

  const beginStroke = useCallback((x: number, y: number) => {
    const point = { x, y, radius: radiusRef.current };
    strokeRef.current = [point];
    setStroke([point]);
    setDrawing(true);
    setCursor({ x, y });
  }, []);

  const extendStroke = useCallback((x: number, y: number) => {
    const point = { x, y, radius: radiusRef.current };
    strokeRef.current = [...strokeRef.current, point];
    setStroke(strokeRef.current);
    setCursor({ x, y });
  }, []);

  const endStroke = useCallback((): BrushStrokePoint[] => {
    const points = strokeRef.current;
    strokeRef.current = [];
    setStroke([]);
    setDrawing(false);
    return points;
  }, []);

  const cancelStroke = useCallback(() => {
    strokeRef.current = [];
    setStroke([]);
    setDrawing(false);
  }, []);

  return {
    brushRadius,
    setBrushRadius,
    nudgeBrushRadius,
    stroke,
    drawing,
    cursor,
    setCursor,
    beginStroke,
    extendStroke,
    endStroke,
    cancelStroke,
    strokeRef,
    minBrushRadius: MIN_BRUSH_RADIUS,
    maxBrushRadius: MAX_BRUSH_RADIUS,
  };
}
