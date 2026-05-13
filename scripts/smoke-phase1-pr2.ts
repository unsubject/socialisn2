// Smoke test for Phase 1 PR 2 adapters: arxiv (RSS 1.0 / RDF) and YouTube
// (Atom + yt: + media: namespaces). Manual run; not part of CI.
//
// Confirms rss-parser handles RDF without customFields and YouTube's nested
// namespaces with the customFields the adapter declares.

import { fetchAndParseArxiv } from '../src/ingestion/arxiv.js';
import { buildChannelFeedUrl, fetchAndParseYouTube } from '../src/ingestion/youtube.js';

async function smokeArxiv(): Promise<void> {
  console.log('\n=== arXiv cs.AI ===');
  const t = Date.now();
  try {
    const items = await fetchAndParseArxiv('http://arxiv.org/rss/cs.AI');
    console.log(`  parsed ${items.length} items in ${Date.now() - t}ms`);
    for (const it of items.slice(0, 2)) {
      console.log(`  - ${it.title.slice(0, 80)}`);
      console.log(`    url: ${it.url}`);
      console.log(`    externalId: ${it.externalId}`);
      console.log(`    author: ${(it.author ?? '(none)').slice(0, 80)}`);
      console.log(`    publishedAt: ${it.publishedAt.toISOString()}`);
    }
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function smokeYouTube(channelId: string, label: string): Promise<void> {
  console.log(`\n=== YouTube ${label} (${channelId}) ===`);
  console.log(`  url: ${buildChannelFeedUrl(channelId)}`);
  const t = Date.now();
  try {
    const videos = await fetchAndParseYouTube(channelId);
    console.log(`  parsed ${videos.length} videos in ${Date.now() - t}ms`);
    for (const v of videos.slice(0, 2)) {
      console.log(`  - ${v.title.slice(0, 80)}`);
      console.log(`    externalId: ${v.externalId}`);
      console.log(`    url: ${v.url}`);
      console.log(`    publishedAt: ${v.publishedAt.toISOString()}`);
      console.log(`    description: ${(v.description ?? '(none)').slice(0, 80)}…`);
    }
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await smokeArxiv();
// 3Blue1Brown — well-known, stable, public.
await smokeYouTube('UCYO_jab_esuFRV4b17AJtAw', '3Blue1Brown');
