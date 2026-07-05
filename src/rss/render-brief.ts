// Server-rendered HTML for the `/brief/:weekOf` weekly-brief page
// (redesign P1). Same discipline as render-detail.ts: semantic HTML,
// small inline stylesheet, no client JS, every model-derived string
// escaped (the body comes from renderBriefBodyHtml, which escapes
// per-field).

import { escapeHtml } from '../lib/escape.js';
import { renderBriefBodyHtml, type BriefPitch } from '../scoring/brief.js';

const PAGE_CSS = `
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 46rem;
         margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  section { border-top: 1px solid #ddd; padding-top: 0.5rem; }
  dl { margin: 0.5rem 0; }
  dt { font-weight: 600; margin-top: 0.6rem; }
  dd { margin: 0.1rem 0 0 0; }
  ul { margin: 0.5rem 0 1rem 1.2rem; padding: 0; }
  .meta { color: #666; font-size: 0.85rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #ddd; }
    section { border-top-color: #333; }
    .meta { color: #999; }
    a { color: #8ab4f8; }
  }
`;

export interface BriefPageContext {
  weekOf: string;
  pitches: BriefPitch[];
  model: string;
  createdAt: Date;
  updatedAt: Date | null;
}

export function renderBriefPage(ctx: BriefPageContext): string {
  const stamp = (ctx.updatedAt ?? ctx.createdAt).toUTCString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Weekly Ideation Brief — ${escapeHtml(ctx.weekOf)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Weekly Ideation Brief — ${escapeHtml(ctx.weekOf)}</h1>
<p class="meta">${ctx.pitches.length} pitches · generated ${escapeHtml(stamp)} · ${escapeHtml(ctx.model)}</p>
${renderBriefBodyHtml(ctx.pitches)}
</body>
</html>
`;
}

export function renderBriefNotFound(weekOf: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Brief not found</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Brief not found</h1>
<p class="meta">No weekly brief for ${escapeHtml(weekOf)}.</p>
</body>
</html>
`;
}
