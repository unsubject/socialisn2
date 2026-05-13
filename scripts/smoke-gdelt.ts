// Manual smoke against the live GDELT GKG API. Not part of CI. Verifies
// the URL builder + response summariser handle real GKG data.

import { fetchGkg, hashGdeltQuery, buildGkgUrl } from '../src/ingestion/gdelt.js';

const input = {
  query: 'Federal Reserve',
  startDate: new Date(Date.now() - 24 * 3600_000),
  endDate: new Date(),
};

console.log('query hash:', hashGdeltQuery(input));
console.log('url:', buildGkgUrl(input));

const t = Date.now();
const coverage = await fetchGkg(input);
console.log(`\nfetched in ${Date.now() - t}ms`);
console.log(JSON.stringify(coverage, null, 2));
