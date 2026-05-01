#!/usr/bin/env node
// @ts-check
/**
 * Phase A — Polymarket ground truth sampler for the US × Iran permanent peace deal event.
 *
 * Fetches https://gamma-api.polymarket.com/events/slug/us-x-iran-permanent-peace-deal-by
 * and appends one JSON line per run.
 *
 * Usage:
 *   node scripts/polymarket-us-iran-peace-snapshot.mjs
 *   POLYMARKET_SAMPLE_OUTPUT=/path/to/file.jsonl node scripts/polymarket-us-iran-peace-snapshot.mjs
 *
 * Every 30 minutes without cron (long-running):
 *   npm run polymarket:watch:us-iran-peace
 *
 * Cron: run `crontab -e` (do not paste cron lines into zsh). Example with minute
 * fields 0 and 30:
 *   0,30 * * * * cd /absolute/path/to/worldmonitor-main && npm run polymarket:sample:us-iran-peace
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const EVENT_SLUG = 'us-x-iran-permanent-peace-deal-by';
const UA = 'worldmonitor-polymarket-snapshot/1.0';

/**
 * @param {unknown} raw
 * @returns {number[]}
 */
function parseOutcomePrices(raw) {
  if (Array.isArray(raw)) return raw.map((x) => Number(x)).filter((n) => !Number.isNaN(n));
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map((x) => Number(x)).filter((n) => !Number.isNaN(n)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * @param {Record<string, unknown>} m
 */
function marketRow(m) {
  const prices = parseOutcomePrices(m.outcomePrices);
  const pYes = prices[0] ?? null;
  const pNo = prices[1] ?? null;
  return {
    marketId: m.id != null ? String(m.id) : '',
    slug: m.slug != null ? String(m.slug) : '',
    question: m.question != null ? String(m.question) : '',
    conditionId: m.conditionId != null ? String(m.conditionId) : '',
    endDate: m.endDate != null ? String(m.endDate) : '',
    outcomes: Array.isArray(m.outcomes) ? m.outcomes.map(String) : [],
    pYes,
    pNo,
    bestBid: m.bestBid != null ? Number(m.bestBid) : null,
    bestAsk: m.bestAsk != null ? Number(m.bestAsk) : null,
    lastTradePrice: m.lastTradePrice != null ? Number(m.lastTradePrice) : null,
    spread: m.spread != null ? Number(m.spread) : null,
    volume: m.volume != null ? String(m.volume) : '',
    liquidity: m.liquidity != null ? String(m.liquidity) : '',
  };
}

export async function runPolymarketUsIranPeaceSnapshot() {
  const sampledAt = Date.now();
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(EVENT_SLUG)}`;

  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  /** @type {Record<string, unknown>} */
  const event = await resp.json();
  const marketsRaw = event.markets;
  const markets = Array.isArray(marketsRaw) ? marketsRaw.map((m) => marketRow(/** @type {Record<string, unknown>} */ (m))) : [];

  const record = {
    sampledAt,
    sampledAtIso: new Date(sampledAt).toISOString(),
    source: 'gamma-api.polymarket.com',
    endpoint: `/events/slug/${EVENT_SLUG}`,
    eventSlug: EVENT_SLUG,
    eventId: event.id != null ? String(event.id) : '',
    eventTitle: event.title != null ? String(event.title) : '',
    eventUpdatedAt: event.updatedAt != null ? String(event.updatedAt) : '',
    markets,
  };

  const outPath =
    process.env.POLYMARKET_SAMPLE_OUTPUT?.trim() ||
    join(__dirname, '..', 'data', 'polymarket', 'us-iran-peace-deal-timeseries.jsonl');

  await mkdir(dirname(outPath), { recursive: true });
  await appendFile(outPath, `${JSON.stringify(record)}\n`, 'utf8');

  console.log(
    `[polymarket-sample] appended sample at ${record.sampledAtIso} → ${outPath} (${markets.length} market row(s))`,
  );
}

async function main() {
  await runPolymarketUsIranPeaceSnapshot();
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[polymarket-sample] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
