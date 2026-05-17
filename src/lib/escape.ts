// Centralised HTML + XML escaping. Single helper, used everywhere a
// candidate-derived string lands in a `/c/:id` detail page or an RSS
// feed. NEVER template-literal-interpolate a raw field — even
// LLM-produced "usually clean" output is the wrong tolerance for
// rendering as HTML or as XML.
//
// Keep this module dependency-free (no escape libs). The OWASP rules
// for HTML attribute / element content + the XML 1.0 control-char
// restrictions are small enough to inline, and pinning them here
// avoids the supply-chain surface of an `xml-escape`-style package.

/**
 * HTML element + attribute escape. Replaces the five reserved chars
 * — & < > " ' — with named or numeric entities. Safe for both element
 * content and double-quoted attribute values (the most common HTML
 * injection vectors); for single-quoted attributes the `'` → `&#39;`
 * replacement keeps it safe too.
 *
 * Does NOT strip control characters: a 0x00 byte in HTML is rendered as
 * an unknown char by most browsers, not interpreted. If you suspect
 * untrusted binary in a field, normalise upstream rather than masking
 * it here.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * XML 1.0 escape — entities for the five reserved chars AND removal of
 * the C0 control characters XML 1.0 forbids in text content (everything
 * 0x00-0x1F except TAB 0x09, LF 0x0A, CR 0x0D). A stray 0x00 from an
 * upstream LLM in an RSS field would make the whole feed invalid XML
 * and break every consumer (rss-parser throws on document parse), so
 * stripping at the boundary here is cheaper than every consumer
 * defending themselves.
 *
 * NOT for use inside CDATA sections — those have their own escaping
 * rules. The generator deliberately avoids CDATA throughout (entities
 * are more reliably handled by every RSS reader) so this single helper
 * is sufficient.
 */
export function escapeXml(s: string): string {
  // Strip C0 controls forbidden in XML 1.0 text: 0x00-0x08, 0x0B-0x0C,
  // 0x0E-0x1F. TAB (0x09), LF (0x0A), CR (0x0D) pass through. Hex
  // escapes (not literal bytes) so the source survives editor / VCS /
  // diff round-trips intact. eslint's no-control-regex flags the
  // character class even via \x escapes — disable explicitly here since
  // stripping these characters is the entire point of the function.
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return stripped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
