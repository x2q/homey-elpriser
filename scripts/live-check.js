#!/usr/bin/env node
'use strict';

/**
 * Asks the LIVE elpriser.org API and prints what the Homey device would show.
 * Also compares the zone table with the live /api/openapi.json.
 *
 *   npm run live            # DK1, DE, GB
 *   npm run live -- se3 pl  # any zones
 *
 * Exits non-zero if the zone table or a response no longer matches what the app expects.
 */

const api = require('../lib/api');
const state = require('../lib/state');
const zones = require('../lib/zones');

const UA = 'Homey-elpriser/live-check (+https://github.com/x2q/homey-elpriser)';

async function main() {
  let failed = false;
  const spec = await (await fetch(`${api.API_BASE}/openapi.json`, { headers: { 'User-Agent': UA } })).json();
  const live = spec.paths['/api/nordic'].get.parameters.find((p) => p.name === 'zone').schema.enum;
  const mine = zones.ZONES.map((z) => z.key);
  const missing = live.filter((k) => !mine.includes(k));
  const extra = mine.filter((k) => !live.includes(k));
  console.log(`zones: ${mine.length} in the app, ${live.length} in the live API`);
  if (missing.length || extra.length) {
    failed = true;
    console.log(`  MISMATCH - missing in the app: ${missing.join(', ') || '-'}; not in the API: ${extra.join(', ') || '-'}`);
  }

  const keys = process.argv.slice(2).length ? process.argv.slice(2) : ['dk1', 'de', 'gb'];
  for (const key of keys) {
    const zone = zones.getZone(key);
    if (!zone) {
      console.log(`${key}: unknown zone`);
      failed = true;
      continue;
    }
    try {
      const res = await api.fetchDayset(zone, {}, { userAgent: UA });
      const st = state.computeState(res.dayset, zone, Date.now());
      const hh = (ms) => (ms === null ? '-' : new Date(ms).toISOString().slice(11, 16) + 'Z');
      console.log(
        `${key}: ${st.covered ? `${st.price} ${st.unit} (hour from ${hh(st.slotStart)}${st.isLatestKnown ? ', latest known' : ''})` : 'no price for this hour'}` +
          ` | next ${st.nextPrice} | min ${st.min} max ${st.max} avg ${st.avg} | level ${st.level} | cheap hour now ${st.cheapHourNow}` +
          ` | cheapest starts ${hh(st.cheapestStart)} | tomorrow published ${st.tomorrowPublished}`,
      );
    } catch (err) {
      failed = true;
      console.log(`${key}: FAILED (${err.kind || 'error'}): ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
