/**
 * Contact sheet layout metadata (PNG composition happens in the CLI via Playwright).
 */

export interface ContactSheetShotEntry {
  shotNumber: string;
  name: string;
  framePath: string;
  status: string;
  warningCount: number;
}

export interface ContactSheetSpec {
  title: string;
  columns: number;
  cellWidth: number;
  cellHeight: number;
  shots: ContactSheetShotEntry[];
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
