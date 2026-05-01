#!/usr/bin/env node
// @ts-check
/**
 * Phase B — Align Oasis mock pipeline output to a Polymarket scalar P(Yes).
 *
 * - Runs the same 3-agent regional pipeline as sim:oasis (default region mena).
 * - Fetches Gamma event `us-x-iran-permanent-peace-deal-by`, picks one market
 *   (POLYMARKET_TARGET_MARKET_SLUG or first market in the event).
 * - Maps scenario lanes → pHat via oasis-sim/market-bridge.mjs (placeholder formula).
 * - Appends one JSON line to data/polymarket/us-iran-oasis-b-alignment.jsonl
 *
 *   npm run sim:oasis:polymarket-b -- --pretty
 *   POLYMARKET_TARGET_MARKET_SLUG=us-x-iran-permanent-peace-deal-by-april-22-2026 npm run sim:oasis:polymarket-b
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REGIONS } from './shared/geography.js';
import { applySelfHostRedisRestDefaults, loadEnvFile } from './_seed-utils.mjs';
import { readSourcesSafeForOasis, runOasisThreeAgentPipeline } from './oasis-sim/pipeline.mjs';
import { oasisLanesToPolymarketYesCalibrated } from './oasis-sim/calibrated-bridge.mjs';
import { buildPredictionContext } from './oasis-sim/prediction-context.mjs';
import { OASIS_SIM_MODE } from './oasis-sim/types.mjs';

loadEnvFile(import.meta.url);
applySelfHostRedisRestDefaults();

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const EVENT_SLUG = 'us-x-iran-permanent-peace-deal-by';
const UA = 'worldmonitor-oasis-polymarket-b/1.0';

const DEFAULT_ALIGNMENT_PATH = join(
  __dirname,
  '..',
  'data',
  'polymarket',
  'us-iran-oasis-b-alignment.jsonl',
);

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
 * @returns {Promise<{ event: Record<string, unknown>; market: Record<string, unknown>; pMarketYes: number | null }>}
 */
async function fetchTargetMarket() {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(EVENT_SLUG)}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Gamma HTTP ${resp.status} for ${url}`);
  /** @type {Record<string, unknown>} */
  const event = await resp.json();
  const marketsRaw = event.markets;
  const markets = Array.isArray(marketsRaw) ? /** @type {Record<string, unknown>[]} */ (marketsRaw) : [];
  const want = (process.env.POLYMARKET_TARGET_MARKET_SLUG ?? '').trim();
  let market = want ? markets.find((m) => String(m.slug ?? '') === want) : null;
  if (!market && markets.length > 0) market = markets[0];
  if (!market) throw new Error('Event has no markets');

  const prices = parseOutcomePrices(market.outcomePrices);
  const pMarketYes = prices.length > 0 ? round(prices[0]) : null;

  return { event, market, pMarketYes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const region = REGIONS.find((r) => r.id === args.regionId);
  if (!region) {
    throw new Error(`Unknown region "${args.regionId}". Try: ${REGIONS.map((r) => r.id).join(', ')}`);
  }

  const startedAt = Date.now();
  const warnings = [];

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    warnings.push('UPSTASH Redis env not set; Oasis pipeline uses empty sources');
  }

  const sources = await readSourcesSafeForOasis(warnings);
  const sourceKeysPresent = Object.entries(sources).filter(([, v]) => v !== null && v !== undefined).length;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && sourceKeysPresent === 0) {
    warnings.push('Redis configured but no source keys returned');
  }

  const { event, market, pMarketYes } = await fetchTargetMarket();

  const { events, trace, warnings: pipeWarnings } = await runOasisThreeAgentPipeline({
    regionId: args.regionId,
    horizon: args.horizon,
    dryRun: args.dryRun,
    startedAt,
    sources,
  });
  warnings.push(...pipeWarnings);

  const marketsList = Array.isArray(event.markets) ? event.markets : [];
  const predictionContext = buildPredictionContext({
    regionId: args.regionId,
    horizon: args.horizon,
    sources,
    polymarket: {
      eventSlug: EVENT_SLUG,
      marketSlug: market.slug != null ? String(market.slug) : '',
      eventSubMarketCount: marketsList.length,
    },
  });

  const bridge = await oasisLanesToPolymarketYesCalibrated(events, {
    calibrationPath: process.env.OASIS_D_CALIBRATION_PATH?.trim() || undefined,
  });
  const gap = pMarketYes != null ? round(bridge.pHat - pMarketYes) : null;

  const finishedAt = Date.now();
  const outPath = process.env.OASIS_B_ALIGNMENT_OUTPUT?.trim() || DEFAULT_ALIGNMENT_PATH;

  const record = {
    kind: 'oasis_b_polymarket_alignment',
    sampledAt: finishedAt,
    sampledAtIso: new Date(finishedAt).toISOString(),
    oasisMode: OASIS_SIM_MODE,
    regionId: args.regionId,
    horizon: args.horizon,
    dryRun: args.dryRun,
    durationMs: finishedAt - startedAt,
    predictionContext,
    polymarket: {
      eventSlug: EVENT_SLUG,
      eventId: event.id != null ? String(event.id) : '',
      marketSlug: market.slug != null ? String(market.slug) : '',
      marketId: market.id != null ? String(market.id) : '',
      question: market.question != null ? String(market.question) : '',
      endDate: market.endDate != null ? String(market.endDate) : '',
      pMarketYes,
    },
    oasis: {
      pHat: bridge.pHat,
      pHatBaseline: bridge.pHatBaseline,
      formulaVersion: bridge.formulaVersion,
      laneProbabilities: bridge.laneProb,
      formulaNote: bridge.formulaNote,
      calibration: bridge.calibration,
      scenarioEvents: events,
      trace,
    },
    alignment: {
      gap,
      absGap: gap != null ? round(Math.abs(gap)) : null,
    },
    warnings: [...new Set(warnings)],
  };

  await mkdir(dirname(outPath), { recursive: true });
  await appendFile(outPath, `${JSON.stringify(record)}\n`, 'utf8');

  if (args.pretty) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  console.log(JSON.stringify(record));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ regionId: string; horizon: '24h' | '7d' | '30d'; dryRun: boolean; pretty: boolean; help: boolean }} */
  const args = {
    regionId: 'mena',
    horizon: '7d',
    dryRun: false,
    pretty: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--region' && argv[i + 1]) args.regionId = argv[++i];
    else if (t === '--horizon' && argv[i + 1]) {
      const h = argv[++i];
      if (h === '24h' || h === '7d' || h === '30d') args.horizon = h;
      else throw new Error(`Invalid --horizon "${h}"`);
    } else if (t === '--dry-run') args.dryRun = true;
    else if (t === '--pretty') args.pretty = true;
    else if (t === '--help' || t === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${t}`);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/run-oasis-polymarket-b.mjs [options]',
      '',
      'Phase B: Oasis lane → pHat vs Polymarket P(Yes); appends JSONL to data/polymarket/us-iran-oasis-b-alignment.jsonl',
      '',
      'Options:',
      '  --region <id>   default mena',
      '  --horizon <h>   24h | 7d | 30d (default 7d)',
      '  --dry-run',
      '  --pretty',
      '  --help',
      '',
      'Env:',
      '  POLYMARKET_TARGET_MARKET_SLUG   pick one market under the event (default: first)',
      '  OASIS_B_ALIGNMENT_OUTPUT          override JSONL path',
      '  OASIS_D_CALIBRATION_PATH          optional path to oasis-d-calibration-weights.json',
    ].join('\n'),
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[oasis-polymarket-b] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

export { main };
