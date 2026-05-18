// compare_against_archive — re-run Stage 5 archive overlap for a
// candidate that's already been scored. Useful when a new 2nd-brain
// essay lands after a candidate was curated — without this tool, the
// candidate's archive_overlap stays at its scoring-time value.
//
// Reads the candidate's cluster centroid, calls
// computeArchiveOverlap (which delegates to two_brain_client's
// archive_search), and returns the matches list + max similarity.
// Does NOT update the candidate row — caller decides whether the new
// overlap value changes their pick/pass calculus.

import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import {
  computeArchiveOverlap,
  type ArchiveOverlapResult,
} from '../../scoring/archive.js';
import { archiveSearch as defaultArchiveSearch } from '../../lib/two_brain_client.js';
import { CompareAgainstArchiveArgs } from '../schemas.js';

export interface CompareDeps {
  /** Override the 2nd-brain search for tests. Matches archiveSearch's
   *  signature. */
  archiveSearcher?: typeof defaultArchiveSearch;
}

export async function compareAgainstArchive(
  db: Db,
  rawArgs: unknown,
  deps: CompareDeps = {},
): Promise<{ matches: ArchiveOverlapResult['links']; max_similarity: number }> {
  const args = CompareAgainstArchiveArgs.parse(rawArgs);
  const searcher = deps.archiveSearcher ?? defaultArchiveSearch;

  // Read the candidate's cluster centroid. Candidates don't store
  // embeddings directly; the cluster is the embedding-bearing unit.
  const rows = await db.execute<{ centroid: string }>(sql`
    SELECT cl.centroid::text AS centroid
    FROM candidates c
    JOIN clusters cl ON cl.id = c.cluster_id
    WHERE c.id = ${args.candidate_id}
    LIMIT 1
  `);
  const row = rows[0];
  // Throw on missing / malformed — server.ts catches and emits
  // isError:true. Returning {error} inline would serialize as a
  // success-shaped content block.
  if (!row) throw new Error(`no candidate ${args.candidate_id}`);

  const centroid = JSON.parse(row.centroid) as unknown;
  if (!Array.isArray(centroid) || !centroid.every((x) => typeof x === 'number')) {
    throw new Error(`candidate ${args.candidate_id} has malformed centroid`);
  }

  const overlap: ArchiveOverlapResult = await computeArchiveOverlap(
    centroid as number[],
    { searcher },
  );

  const maxSimilarity = overlap.links.reduce(
    (max, l) => (l.similarity > max ? l.similarity : max),
    0,
  );

  return { matches: overlap.links, max_similarity: maxSimilarity };
}
