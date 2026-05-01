#!/usr/bin/env node
// @ts-check
/**
 * Runs runPolymarketUsIranPeaceSnapshot() immediately, then every N minutes (default 30).
 * Long-running process — use instead of cron when you want `npm run` only.
 *
 *   npm run polymarket:watch:us-iran-peace
 *
 * Optional:
 *   POLYMARKET_SAMPLE_INTERVAL_MIN=15 npm run polymarket:watch:us-iran-peace
 */

import { runPolymarketUsIranPeaceSnapshot } from './polymarket-us-iran-peace-snapshot.mjs';

const rawMin = Number(process.env.POLYMARKET_SAMPLE_INTERVAL_MIN);
const intervalMin = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 30;
const intervalMs = intervalMin * 60 * 1000;

let busy = false;

async function tick() {
  if (busy) {
    console.warn('[polymarket-watch] previous sample still running — skipping this tick');
    return;
  }
  busy = true;
  try {
    await runPolymarketUsIranPeaceSnapshot();
  } catch (err) {
    console.error(`[polymarket-watch] sample failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    busy = false;
  }
}

console.log(
  `[polymarket-watch] interval=${intervalMin}m — first sample now, then every ${intervalMin}m (Ctrl+C to stop)`,
);

await tick();

setInterval(() => {
  void tick();
}, intervalMs);
