// Server-rendered HTML for the `/c/:id` candidate detail page.
//
// Minimal, no client JS, no CSS framework — semantic HTML + a small
// inline stylesheet so the page renders fine without any external
// resources (the detail page is also reached from RSS reader "open in
// browser" actions which sometimes proxy through readers that strip
// external assets).
//
// Every candidate-derived string flows through `escapeHtml` from
// src/lib/escape.ts. There is no path through this module where a raw
// field is interpolated into the output — see the module header in
// `src/lib/escape.ts` for why this discipline matters even for
// "usually clean" LLM output.

import { escapeHtml } from '../lib/escape.js';

/**
 * What the route handler fetches and threads in. Decoupling this shape
 * from the drizzle row types means the route's query can evolve
 * (denorm vs join, cached vs live) without touching the renderer.
 */
export interface DetailContext {
  candidate: {
    id: string;
    headline: string;
    contextSummary: string;
    primaryDomain: string;
    domains: string[];
    keywords: string[];
    tags: string[];
    temperature: string;
    trajectory: string;
    isExclusive: boolean;
    archiveOverlap: number;
    curationRationale: string | null;
    createdAt: Date;
  };
  /** Source items in the candidate's cluster — one per raw_item. */
  sources: Array<{
    name: string;
    url: string;
    publishedAt: Date;
  }>;
  /** Archive overlap matches per Stage 5 (may be empty). */
  archiveLinks: Array<{
    title: string;
    url: string;
    similarity: number;
    /** 'essay' | 'episode' per 2nd-brain payload shape. Free-form to
     *  tolerate future archive backends adding kinds. */
    type: string;
  }>;
}

/**
 * Build the full HTML document. Returns a string; the caller is
 * responsible for setting `Content-Type: text/html; charset=utf-8`.
 */
export function renderDetail(ctx: DetailContext): string {
  const c = ctx.candidate;
  const metaLine = [
    escapeHtml(c.primaryDomain),
    escapeHtml(c.temperature),
    escapeHtml(c.trajectory),
    c.isExclusive ? '<strong>EXCLUSIVE</strong>' : '',
    `archive overlap ${c.archiveOverlap.toFixed(2)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const sourcesList =
    ctx.sources.length === 0
      ? '<p><em>No sources recorded.</em></p>'
      : `<ul class="sources">${ctx.sources
          .map(
            (s) =>
              `<li><a href="${escapeHtml(s.url)}" rel="noopener noreferrer">${escapeHtml(s.name)}</a> · <time datetime="${escapeHtml(s.publishedAt.toISOString())}">${escapeHtml(s.publishedAt.toISOString())}</time></li>`,
          )
          .join('')}</ul>`;

  const archiveSection =
    ctx.archiveLinks.length === 0
      ? ''
      : `<section>
    <h2>Archive overlap</h2>
    <ul class="archive">${ctx.archiveLinks
      .map(
        (a) =>
          `<li><a href="${escapeHtml(a.url)}" rel="noopener noreferrer">${escapeHtml(a.title)}</a> · ${escapeHtml(a.type)} · similarity ${a.similarity.toFixed(2)}</li>`,
      )
      .join('')}</ul>
  </section>`;

  const curationSection = c.curationRationale
    ? `<section>
    <h2>Curation rationale</h2>
    <p>${escapeHtml(c.curationRationale)}</p>
  </section>`
    : '';

  const keywordsLine =
    c.keywords.length === 0
      ? ''
      : `<p class="keywords"><strong>Keywords:</strong> ${c.keywords.map(escapeHtml).join(', ')}</p>`;

  const tagsLine =
    c.tags.length === 0
      ? ''
      : `<p class="tags"><strong>Tags:</strong> ${c.tags.map(escapeHtml).join(', ')}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(c.headline)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.6rem; line-height: 1.25; margin-bottom: 0.25rem; }
    .meta { color: #555; font-size: 0.9rem; margin-top: 0; }
    .keywords, .tags { font-size: 0.9rem; color: #444; }
    section { margin-top: 1.5rem; }
    section h2 { font-size: 1.1rem; }
    ul.sources, ul.archive { padding-left: 1.25rem; }
    ul.sources li, ul.archive li { margin-bottom: 0.25rem; font-size: 0.95rem; }
    a { color: #06c; }
  </style>
</head>
<body>
  <article>
    <h1>${escapeHtml(c.headline)}</h1>
    <p class="meta">${metaLine}</p>
    ${keywordsLine}
    ${tagsLine}
    <section>
      <h2>Context</h2>
      <p>${escapeHtml(c.contextSummary)}</p>
    </section>
    ${curationSection}
    <section>
      <h2>Sources</h2>
      ${sourcesList}
    </section>
    ${archiveSection}
    <p class="meta">Generated <time datetime="${escapeHtml(c.createdAt.toISOString())}">${escapeHtml(c.createdAt.toISOString())}</time></p>
  </article>
</body>
</html>`;
}

/**
 * 404 body for a missing candidate id. Plain text — no need to render
 * a full page chrome for a triage path.
 */
export function renderNotFound(id: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found</title></head>
<body>
  <h1>404 — candidate not found</h1>
  <p>No candidate with id <code>${escapeHtml(id)}</code>.</p>
</body>
</html>`;
}
