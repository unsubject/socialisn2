// Smoke test: fetch + parse a handful of real seeded feeds and report what
// the adapter produced. Not part of CI — run manually with `tsx scripts/
// smoke-rss.ts` before shipping ingestion changes.

import { fetchAndParseRss } from '../src/ingestion/rss.js';
import { urlHash, titleHash } from '../src/ingestion/dedup.js';

const URLS = [
  // RSS 2.0 news (in seeds)
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  // Substack (in seeds — §6.6 commentators)
  'https://sinocism.com/feed',
  // Podcast (in seeds — Reuters World News)
  'https://feeds.megaphone.fm/reutersworldnews',
];

async function smoke(url: string): Promise<void> {
  console.log(`\n=== ${url} ===`);
  const start = Date.now();
  try {
    const items = await fetchAndParseRss(url);
    const dt = Date.now() - start;
    console.log(`  parsed ${items.length} items in ${dt}ms`);
    const sample = items.slice(0, 2);
    for (const [i, it] of sample.entries()) {
      console.log(`  [${i}] title: ${it.title.slice(0, 80)}`);
      console.log(`      url: ${it.url}`);
      console.log(`      externalId: ${it.externalId}`);
      console.log(`      author: ${it.author ?? '(none)'}`);
      console.log(`      publishedAt: ${it.publishedAt.toISOString()}`);
      console.log(`      content: ${(it.content ?? '(none)').slice(0, 60)}…`);
      console.log(`      url_hash: ${urlHash(it.url).slice(0, 16)}…`);
      console.log(`      title_hash: ${titleHash(it.title).slice(0, 16)}…`);
    }
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const url of URLS) {
  await smoke(url);
}
