/**
 * Contact sheet layout metadata (PNG composition happens in the CLI via Playwright).
 */

export interface ContactSheetShotEntry {
  shotNumber: string;
  name: string;
  framePath: string;
  status: string;
  warningCount: number;
  /** Must be true for paths produced by the canonical clean clay renderer. */
  fromCanonicalRenderer?: boolean;
}

export interface ContactSheetSpec {
  title: string;
  columns: number;
  cellWidth: number;
  cellHeight: number;
  shots: ContactSheetShotEntry[];
}

export interface ContactSheetPreflightIssue {
  code: string;
  message: string;
  shotNumber?: string;
  framePath?: string;
}

export interface ContactSheetPreflightResult {
  ok: boolean;
  issues: ContactSheetPreflightIssue[];
}

export function buildContactSheetSpec(params: {
  title: string;
  shots: ContactSheetShotEntry[];
  columns?: number;
}): ContactSheetSpec {
  const columns = params.columns ?? Math.min(4, Math.max(1, params.shots.length));
  return {
    title: params.title,
    columns,
    cellWidth: 480,
    cellHeight: 320,
    shots: params.shots,
  };
}

/**
 * Contact-sheet preflight: every referenced file must be a clean canonical PNG.
 * Rejects debug/UI screenshot paths and non-PNG artifacts.
 */
export function preflightContactSheet(params: {
  shots: ContactSheetShotEntry[];
  /** Absolute path → file checks */
  fileExists: (path: string) => boolean | Promise<boolean>;
  /** Optional PNG dimension reader (width, height). */
  readPngSize?: (path: string) =>
    | { width: number; height: number; isPng: boolean }
    | Promise<{ width: number; height: number; isPng: boolean }>;
  /** Expected aspect ratio (width/height), e.g. 16/9. */
  expectedAspectRatio?: number;
  aspectTolerance?: number;
}): ContactSheetPreflightResult | Promise<ContactSheetPreflightResult> {
  const run = async (): Promise<ContactSheetPreflightResult> => {
    const issues: ContactSheetPreflightIssue[] = [];
    const aspect = params.expectedAspectRatio;
    const tol = params.aspectTolerance ?? 0.08;

    for (const shot of params.shots) {
      const framePath = shot.framePath;
      if (!framePath) {
        issues.push({
          code: 'frame_path_missing',
          message: `Shot ${shot.shotNumber} has no framePath.`,
          shotNumber: shot.shotNumber,
        });
        continue;
      }

      // Reject debug/UI screenshot paths.
      const normalized = framePath.replace(/\\/g, '/').toLowerCase();
      if (
        normalized.includes('/debug/')
        || normalized.endsWith('-ui.png')
        || normalized.includes('screenshot')
      ) {
        issues.push({
          code: 'debug_path_rejected',
          message: `Shot ${shot.shotNumber} framePath looks like a debug/UI screenshot.`,
          shotNumber: shot.shotNumber,
          framePath,
        });
      }

      if (shot.fromCanonicalRenderer === false) {
        issues.push({
          code: 'not_canonical_renderer',
          message: `Shot ${shot.shotNumber} frame was not produced by the canonical clay renderer.`,
          shotNumber: shot.shotNumber,
          framePath,
        });
      }

      const exists = await params.fileExists(framePath);
      if (!exists) {
        issues.push({
          code: 'frame_missing',
          message: `Shot ${shot.shotNumber} frame file does not exist.`,
          shotNumber: shot.shotNumber,
          framePath,
        });
        continue;
      }

      if (!normalized.endsWith('.png')) {
        issues.push({
          code: 'not_png',
          message: `Shot ${shot.shotNumber} frame is not a PNG.`,
          shotNumber: shot.shotNumber,
          framePath,
        });
      }

      if (params.readPngSize) {
        const size = await params.readPngSize(framePath);
        if (!size.isPng) {
          issues.push({
            code: 'invalid_png',
            message: `Shot ${shot.shotNumber} file is not a valid PNG.`,
            shotNumber: shot.shotNumber,
            framePath,
          });
        } else if (aspect && size.height > 0) {
          const measured = size.width / size.height;
          if (Math.abs(measured - aspect) > tol) {
            issues.push({
              code: 'aspect_mismatch',
              message: `Shot ${shot.shotNumber} aspect ${measured.toFixed(3)} ≠ expected ${aspect.toFixed(3)}.`,
              shotNumber: shot.shotNumber,
              framePath,
            });
          }
        }
      }
    }

    return { ok: issues.length === 0, issues };
  };

  return run();
}

/** HTML document rendered by Playwright to produce contact-sheet.png. */
export function contactSheetHtml(spec: ContactSheetSpec): string {
  const rows = Math.ceil(spec.shots.length / spec.columns) || 1;
  const width = spec.columns * spec.cellWidth + 48;
  const height = 72 + rows * (spec.cellHeight + 56) + 24;
  const cards = spec.shots.map((shot) => {
    const statusColor = shot.status === 'passed'
      ? '#16a34a'
      : shot.status === 'warning' || shot.status === 'needs_review'
        ? '#ca8a04'
        : shot.status === 'failed'
          ? '#dc2626'
          : '#64748b';
    return `
      <article class="card">
        <div class="meta">
          <span class="num">${escapeHtml(shot.shotNumber)}</span>
          <span class="name">${escapeHtml(shot.name)}</span>
        </div>
        <img src="${escapeHtml(shot.framePath)}" alt="Shot ${escapeHtml(shot.shotNumber)}" />
        <div class="status" style="color:${statusColor}">
          ${escapeHtml(shot.status)}${shot.warningCount > 0 ? ` · ${shot.warningCount} warning(s)` : ''}
        </div>
      </article>
    `;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(spec.title)}</title>
<style>
  html, body { margin: 0; padding: 0; background: #111827; color: #f8fafc; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; }
  main { width: ${width}px; min-height: ${height}px; padding: 20px; box-sizing: border-box; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 16px; letter-spacing: 0.02em; }
  .grid { display: grid; grid-template-columns: repeat(${spec.columns}, ${spec.cellWidth}px); gap: 16px; }
  .card { background: #1f2937; border: 1px solid #374151; overflow: hidden; }
  .meta { display: flex; gap: 8px; padding: 8px 10px; font-size: 13px; }
  .num { font-weight: 700; color: #93c5fd; }
  .name { color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  img { display: block; width: ${spec.cellWidth}px; height: ${spec.cellHeight - 40}px; object-fit: cover; background: #0f172a; }
  .status { padding: 6px 10px 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(spec.title)}</h1>
  <div class="grid">${cards}</div>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
