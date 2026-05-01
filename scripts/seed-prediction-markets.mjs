#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile, CHROME_UA, sleep, runSeed } from './_seed-utils.mjs';
import {
  isExcluded, parseYesPrice, filterAndScore, isExpired, buildModule1Candidates,
} from './_prediction-scoring.mjs';
import {
  enrichCandidatesWithModules234Async,
  loadOptionalPolymarketSnapshotJsonl,
} from './_polymarket-seed-enrichment.mjs';
import predictionTags from './data/prediction-tags.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLY_SNAPSHOT_JSONL = join(__dirname, '..', 'data', 'polymarket', 'us-iran-peace-deal-timeseries.jsonl');

const CANONICAL_KEY = 'prediction:markets-bootstrap:v1';
const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval (gold standard: survive 5 missed runs)

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT = 10_000;
const TAG_DELAY_MS = 300;

const GEOPOLITICAL_TAGS = predictionTags.geopolitical;
const TECH_TAGS = predictionTags.tech;
const FINANCE_TAGS = predictionTags.finance;

async function fetchEventsByTag(tag, limit = 20) {
  const params = new URLSearchParams({
    tag_slug: tag,
    closed: 'false',
    active: 'true',
    archived: 'false',
    end_date_min: new Date().toISOString(),
    order: 'volume',
    ascending: 'false',
    limit: String(limit),
  });

  const resp = await fetch(`${GAMMA_BASE}/events?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) {
    console.warn(`  [${tag}] HTTP ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

async function fetchKalshiEvents() {
  try {
    const params = new URLSearchParams({
      status: 'open',
      with_nested_markets: 'true',
      limit: '100',
    });
    const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
    const resp = await fetch(`${KALSHI_BASE}/events?${params}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      console.warn(`  [kalshi] HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    return Array.isArray(data?.events) ? data.events : [];
  } catch (err) {
    console.warn(`  [kalshi] error fetching events: ${err.message}`);
    return [];
  }
}

function kalshiTitle(marketTitle, eventTitle) {
  if (!marketTitle) return eventTitle || '';
  if (marketTitle.includes('?') || marketTitle.length > 60) return marketTitle;
  if (!eventTitle || marketTitle === eventTitle) return marketTitle;
  return `${eventTitle}: ${marketTitle}`;
}

async function fetchKalshiMarkets() {
  const events = await fetchKalshiEvents();
  const results = [];

  for (const event of events) {
    if (!Array.isArray(event.markets) || event.markets.length === 0) continue;
    if (isExcluded(event.title)) continue;

    const binaryActive = event.markets.filter(
      m => m.market_type === 'binary' && m.status === 'active',
    );
    if (binaryActive.length === 0) continue;

    const topMarket = binaryActive.reduce((best, m) => {
      const vol = parseFloat(m.volume_fp) || 0;
      const bestVol = parseFloat(best.volume_fp) || 0;
      return vol > bestVol ? m : best;
    });

    const volume = parseFloat(topMarket.volume_fp) || 0;
    if (volume <= 5000) continue;

    const rawPrice = parseFloat(topMarket.last_price_dollars);
    const yesPrice = Number.isFinite(rawPrice) ? +(rawPrice * 100).toFixed(1) : 50;

    const marketTitle = topMarket.yes_sub_title || topMarket.title || '';
    const title = kalshiTitle(marketTitle, event.title);

    results.push({
      marketId: topMarket.ticker ?? topMarket.id ?? topMarket.market_id ?? title,
      eventId: event.event_ticker ?? event.series_ticker ?? event.id ?? title,
      title,
      yesPrice,
      volume,
      volume24h: volume,
      liquidity: parseFloat(topMarket.open_interest_fp) || parseFloat(topMarket.open_interest) || volume,
      bestBid: parseFloat(topMarket.yes_bid_dollars) || parseFloat(topMarket.bid_dollars) || null,
      bestAsk: parseFloat(topMarket.yes_ask_dollars) || parseFloat(topMarket.ask_dollars) || null,
      url: `https://kalshi.com/markets/${topMarket.ticker}`,
      endDate: topMarket.close_time ?? undefined,
      tags: [],
      source: 'kalshi',
      isActive: topMarket.status === 'active',
      acceptingOrders: topMarket.status === 'active',
    });
  }

  return results;
}

async function fetchAllPredictions() {
  const allTags = [...new Set([...GEOPOLITICAL_TAGS, ...TECH_TAGS, ...FINANCE_TAGS])];
  const seen = new Set();
  const markets = [];

  // Start Kalshi fetch early so it overlaps with Polymarket tag iterations
  const kalshiPromise = fetchKalshiMarkets();

  for (const tag of allTags) {
    try {
      const events = await fetchEventsByTag(tag, 20);
      console.log(`  [${tag}] ${events.length} events`);

      for (const event of events) {
        if (event.closed || seen.has(event.id)) continue;
        seen.add(event.id);
        if (isExcluded(event.title)) continue;

        const eventVolume = event.volume ?? 0;
        if (eventVolume < 1000) continue;

        if (event.markets?.length > 0) {
          const active = event.markets.filter(m => !m.closed && !isExpired(m.endDate));
          if (active.length === 0) continue;

          const topMarket = active.reduce((best, m) => {
            const vol = m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0);
            const bestVol = best.volumeNum ?? (best.volume ? parseFloat(best.volume) : 0);
            return vol > bestVol ? m : best;
          });

          const yesPrice = parseYesPrice(topMarket);
          if (yesPrice === null) continue;

          markets.push({
            marketId: topMarket.id ?? topMarket.conditionId ?? topMarket.slug ?? topMarket.question ?? event.id,
            eventId: event.id ?? event.slug ?? topMarket.id,
            title: topMarket.question || event.title,
            yesPrice,
            volume: eventVolume,
            volume24h: topMarket.volumeNum ?? (topMarket.volume ? parseFloat(topMarket.volume) : eventVolume),
            liquidity: topMarket.liquidityNum ?? (topMarket.liquidity ? parseFloat(topMarket.liquidity) : eventVolume),
            bestBid: topMarket.bestBid ?? topMarket.best_bid ?? null,
            bestAsk: topMarket.bestAsk ?? topMarket.best_ask ?? null,
            spreadPct: topMarket.spreadPct ?? topMarket.spread ?? null,
            url: `https://polymarket.com/event/${event.slug}`,
            endDate: topMarket.endDate ?? event.endDate ?? undefined,
            tags: (event.tags ?? []).map(t => t.slug),
            source: 'polymarket',
            isActive: topMarket.active ?? (!topMarket.closed),
            acceptingOrders: topMarket.acceptingOrders ?? topMarket.accepting_orders ?? (!topMarket.closed),
          });
        }
      }
    } catch (err) {
      console.warn(`  [${tag}] error: ${err.message}`);
    }
    await sleep(TAG_DELAY_MS);
  }

  // Await the Kalshi fetch that was started in parallel with tag iterations
  const kalshiMarkets = await kalshiPromise;
  console.log(`  [kalshi] ${kalshiMarkets.length} markets`);
  markets.push(...kalshiMarkets);

  console.log(`  total raw markets: ${markets.length}`);
  const { candidates, stats } = buildModule1Candidates(markets, {
    minTarget: 50,
    maxCandidates: 100,
  });
  console.log(`  module1 stats: raw=${stats.raw}, normalized=${stats.normalized}, strictPassed=${stats.strictPassed}, passed=${stats.passed}, deduped=${stats.deduped}, usedRelaxed=${stats.usedRelaxed}`);
  console.log(`  module1 candidates: ${candidates.length}`);

  const snapshotPath = process.env.POLYMARKET_SNAPSHOT_JSONL || DEFAULT_POLY_SNAPSHOT_JSONL;
  const snap = await loadOptionalPolymarketSnapshotJsonl(snapshotPath);
  console.log(`  polymarket snapshot jsonl: path=${snap.path} loaded=${snap.loaded} records=${snap.records.length}`);
  const module4Bankroll = Number(process.env.POLYMARKET_MODULE4_BANKROLL || 10_000);

  const seedLlmOn = process.env.POLYMARKET_SEED_LLM === '1' || process.env.POLYMARKET_SEED_LLM === 'true';
  let callLlm = null;
  if (seedLlmOn) {
    if (process.env.ANTHROPIC_API_KEY) {
      const { createAnthropicCallLlm } = await import('./_polymarket-anthropic.mjs');
      callLlm = await createAnthropicCallLlm();
      console.log('  polymarket seed LLM: ON (module3 Claude + module4 Bull/Bear/Judge for first N candidates)');
    } else {
      console.warn('  polymarket seed LLM: POLYMARKET_SEED_LLM set but ANTHROPIC_API_KEY missing — using degraded path');
    }
  }

  const llmMaxCandidates = Number(process.env.POLYMARKET_SEED_LLM_MAX ?? 5);
  const llmDelayMs = Number(process.env.POLYMARKET_SEED_LLM_DELAY_MS ?? 450);
  const { candidates: enrichedCandidates, stats: enrichStats } = await enrichCandidatesWithModules234Async(
    candidates,
    snap.records,
    {
      useLlm: Boolean(seedLlmOn && callLlm),
      callLlm: callLlm ?? undefined,
      llmMaxCandidates,
      llmDelayMs,
      module4Bankroll,
    },
  );
  console.log(`  modules2-4 on candidates: snapshotRows=${snap.records.length} marketsWithDetection=${enrichStats.snapshotMarketsDetected} smartMoneyAttached=${enrichStats.smartMoneyAttached}/${enrichStats.candidateCount}`);
  if (enrichStats.useLlm) {
    console.log(`  seed LLM stats: attempted=${enrichStats.llmCandidatesAttempted} ok=${enrichStats.llmCandidatesSucceeded} failed=${enrichStats.llmCandidatesFailed} max=${enrichStats.llmMaxConfigured}`);
  }

  const geopolitical = filterAndScore(markets, null);
  const tech = filterAndScore(markets, m => m.tags?.some(t => TECH_TAGS.includes(t)));
  const finance = filterAndScore(markets, m => m.source === 'kalshi' || m.tags?.some(t => FINANCE_TAGS.includes(t)));

  console.log(`  geopolitical: ${geopolitical.length}, tech: ${tech.length}, finance: ${finance.length}`);

  return {
    candidates: enrichedCandidates,
    polymarketEnrichment: {
      snapshotPath: snap.path,
      snapshotLoaded: snap.loaded,
      snapshotRecordRows: snap.records.length,
      snapshotMarketsDetected: enrichStats.snapshotMarketsDetected,
      smartMoneyAttached: enrichStats.smartMoneyAttached,
      candidateCount: enrichStats.candidateCount,
      seedLlm: Boolean(enrichStats.useLlm),
      llmCandidatesAttempted: enrichStats.llmCandidatesAttempted,
      llmCandidatesSucceeded: enrichStats.llmCandidatesSucceeded,
      llmCandidatesFailed: enrichStats.llmCandidatesFailed,
      llmMaxConfigured: enrichStats.llmMaxConfigured,
    },
    geopolitical,
    tech,
    finance,
    fetchedAt: Date.now(),
  };
}

await runSeed('prediction', 'markets', CANONICAL_KEY, fetchAllPredictions, {
  ttlSeconds: CACHE_TTL,
  lockTtlMs: 60_000,
  validateFn: (data) =>
    Array.isArray(data?.candidates)
    && (data?.geopolitical?.length > 0 || data?.tech?.length > 0)
    && data?.finance?.length > 0,
});
