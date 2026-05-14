// Pure parsing helpers for email-handler.ts. Kept independent of the
// Workers runtime so they can be unit-tested under plain Node + vitest
// without spinning up Miniflare.

const BOILERPLATE_MARKERS: RegExp[] = [
  // Common newsletter footer phrasing. Case-insensitive, multi-line
  // anchored: we cut from the FIRST appearance of any marker onward.
  // Aggressive by design — preserving the unsubscribe / list-management
  // block has no clustering value and pollutes the downstream embedding.
  /^[ \t]*unsubscribe\b/im,
  /^[ \t]*if you no longer wish to receive/im,
  /^[ \t]*view (this )?(email|message) in your browser/im,
  /^[ \t]*this (email|message) was sent to /im,
  /^[ \t]*to stop receiving/im,
  /^[ \t]*manage (your )?(subscription|preferences)/im,
  /^[ \t]*update your preferences/im,
  /^[ \t]*sent (with )?love by/im,
  /^[ \t]*©\s*\d{4}/im,
  /^[ \t]*copyright\s*©/im,
];

/**
 * Cut the body at the FIRST boilerplate marker we recognise. Returns the
 * prefix as a trimmed string. If no marker fires, returns the input
 * trimmed. Empty input → empty string.
 */
export function stripBoilerplate(text: string): string {
  if (!text) return '';
  let cutAt = text.length;
  for (const re of BOILERPLATE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cutAt) cutAt = m.index;
  }
  return text.slice(0, cutAt).trimEnd();
}

export interface ExtractedLink {
  url: string;
  pos: number;
}

const HREF_RE = /<a\s[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g;

/**
 * Pull links out of an email body. Prefers HTML when available (parses
 * <a href>); falls back to bare-URL regex on plain text. Returns links in
 * document order with a 0-based positional index. Filters out anchors,
 * mailto:, javascript:, and obvious unsubscribe URLs (which carry no
 * editorial signal and would pollute the inbox_links join).
 */
export function extractLinks(opts: {
  html?: string | null;
  text?: string | null;
}): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  const push = (rawUrl: string): void => {
    const url = rawUrl.trim();
    if (!url) return;
    if (url.startsWith('#')) return;
    if (url.startsWith('mailto:')) return;
    if (url.startsWith('javascript:')) return;
    if (url.startsWith('tel:')) return;
    // Drop the common one-click unsubscribe / preferences URLs — operators
    // care about content links, not list-management endpoints.
    if (/\b(unsubscribe|email[-_ ]?preferences|opt[-_ ]?out)\b/i.test(url)) {
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, pos: out.length });
  };

  if (opts.html && opts.html.length > 0) {
    let m: RegExpExecArray | null;
    HREF_RE.lastIndex = 0;
    while ((m = HREF_RE.exec(opts.html)) !== null) {
      if (m[1]) push(m[1]);
    }
    return out;
  }

  if (opts.text && opts.text.length > 0) {
    let m: RegExpExecArray | null;
    BARE_URL_RE.lastIndex = 0;
    while ((m = BARE_URL_RE.exec(opts.text)) !== null) {
      push(m[0]);
    }
  }
  return out;
}
