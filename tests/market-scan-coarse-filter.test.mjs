import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FILTER_CONFIG,
  RELAXED_FILTER_CONFIG,
  computeDaysToExpiry,
  computeSpreadPct,
  pickCheaperSide,
  normalizeCoarseMarket,
  passesCoarseFilter,
  dedupeByEventAndCheaperSide,
  buildModule1Candidates,
} from '../scripts/_prediction-scoring.mjs';

const NOW = Date.parse('2026-04-21T00:00:00.000Z');

function isoInDays(days) {
  return new Date(NOW + (days * 24 * 60 * 60 * 1000)).toISOString();
}

function rawMarket(overrides = {}) {
  return {
    marketId: 'm-1',
    eventId: 'e-1',
    title: 'Will a ceasefire happen this quarter?',
    yesPrice: 0.2,
    volume24h: 10_000,
    liquidity: 12_000,
    bestBid: 0.19,
    bestAsk: 0.2,
    spreadPct: 0.05,
    endDate: isoInDays(20),
    isActive: true,
    acceptingOrders: true,
    source: 'polymarket',
    ...overrides,
  };
}

describe('module1 coarse filter boundaries', () => {
  it('price_range_boundary: 5c and 50c pass; outside rejects', () => {
    const base = normalizeCoarseMarket(rawMarket({ yesPrice: 0.05 }), NOW);
    assert.ok(passesCoarseFilter(base, FILTER_CONFIG, NOW));

    const edge = normalizeCoarseMarket(rawMarket({ yesPrice: 0.5 }), NOW);
    assert.ok(passesCoarseFilter(edge, FILTER_CONFIG, NOW));

    const below = normalizeCoarseMarket(rawMarket({ yesPrice: 0.049 }), NOW);
    assert.ok(!passesCoarseFilter(below, FILTER_CONFIG, NOW));

    const above = normalizeCoarseMarket(rawMarket({ yesPrice: 0.501, noPrice: 0.6 }), NOW);
    assert.ok(!passesCoarseFilter(above, FILTER_CONFIG, NOW));
  });

  it('volume_threshold: 4999 reject, 5000 pass', () => {
    const below = normalizeCoarseMarket(rawMarket({ volume24h: 4999 }), NOW);
    const exact = normalizeCoarseMarket(rawMarket({ volume24h: 5000 }), NOW);
    assert.ok(!passesCoarseFilter(below, FILTER_CONFIG, NOW));
    assert.ok(passesCoarseFilter(exact, FILTER_CONFIG, NOW));
  });

  it('liquidity_threshold: 9999 reject, 10000 pass', () => {
    const below = normalizeCoarseMarket(rawMarket({ liquidity: 9999 }), NOW);
    const exact = normalizeCoarseMarket(rawMarket({ liquidity: 10000 }), NOW);
    assert.ok(!passesCoarseFilter(below, FILTER_CONFIG, NOW));
    assert.ok(passesCoarseFilter(exact, FILTER_CONFIG, NOW));
  });

  it('spread_threshold: 5.0% pass, 5.1% reject', () => {
    const pass = normalizeCoarseMarket(rawMarket({ spreadPct: 0.05 }), NOW);
    const fail = normalizeCoarseMarket(rawMarket({ spreadPct: 0.051 }), NOW);
    assert.ok(passesCoarseFilter(pass, FILTER_CONFIG, NOW));
    assert.ok(!passesCoarseFilter(fail, FILTER_CONFIG, NOW));
  });

  it('expiry_window: [3, 90] inclusive', () => {
    const d2 = normalizeCoarseMarket(rawMarket({ endDate: isoInDays(2) }), NOW);
    const d3 = normalizeCoarseMarket(rawMarket({ endDate: isoInDays(3) }), NOW);
    const d90 = normalizeCoarseMarket(rawMarket({ endDate: isoInDays(90) }), NOW);
    const d91 = normalizeCoarseMarket(rawMarket({ endDate: isoInDays(91) }), NOW);

    assert.ok(!passesCoarseFilter(d2, FILTER_CONFIG, NOW));
    assert.ok(passesCoarseFilter(d3, FILTER_CONFIG, NOW));
    assert.ok(passesCoarseFilter(d90, FILTER_CONFIG, NOW));
    assert.ok(!passesCoarseFilter(d91, FILTER_CONFIG, NOW));
  });

  it('active_and_accept_orders: both must be true', () => {
    const inactive = normalizeCoarseMarket(rawMarket({ isActive: false }), NOW);
    const noOrders = normalizeCoarseMarket(rawMarket({ acceptingOrders: false }), NOW);
    const good = normalizeCoarseMarket(rawMarket(), NOW);

    assert.ok(!passesCoarseFilter(inactive, FILTER_CONFIG, NOW));
    assert.ok(!passesCoarseFilter(noOrders, FILTER_CONFIG, NOW));
    assert.ok(passesCoarseFilter(good, FILTER_CONFIG, NOW));
  });

  it('missing_or_invalid_fields: reject safely without throw', () => {
    const invalidPrice = normalizeCoarseMarket(rawMarket({ yesPrice: 'oops' }), NOW);
    const missingSpread = normalizeCoarseMarket(rawMarket({ spreadPct: null, bestBid: null, bestAsk: null }), NOW);
    const invalidDate = normalizeCoarseMarket(rawMarket({ endDate: 'bad-date' }), NOW);

    assert.equal(invalidPrice, null);
    assert.ok(!passesCoarseFilter(missingSpread, FILTER_CONFIG, NOW));
    assert.ok(!passesCoarseFilter(invalidDate, FILTER_CONFIG, NOW));
  });
});

describe('module1 side pick and dedupe', () => {
  it('yes_no_cheaper_side_pick keeps cheaper side', () => {
    const picked = pickCheaperSide(0.32, 0.68);
    assert.equal(picked.side, 'yes');
    assert.equal(picked.currentPrice, 32);

    const pickedNo = pickCheaperSide(0.73, 0.27);
    assert.equal(pickedNo.side, 'no');
    assert.equal(pickedNo.currentPrice, 27);
  });

  it('event_level_dedup keeps single candidate per event', () => {
    const markets = [
      normalizeCoarseMarket(rawMarket({ marketId: 'm-a', eventId: 'event-1', yesPrice: 0.3 }), NOW),
      normalizeCoarseMarket(rawMarket({ marketId: 'm-b', eventId: 'event-1', yesPrice: 0.25 }), NOW),
      normalizeCoarseMarket(rawMarket({ marketId: 'm-c', eventId: 'event-2', yesPrice: 0.22 }), NOW),
    ];

    const deduped = dedupeByEventAndCheaperSide(markets);
    assert.equal(deduped.length, 2);
    assert.ok(deduped.some(m => m.marketId === 'm-b'));
    assert.ok(deduped.some(m => m.marketId === 'm-c'));
  });
});

describe('module1 candidate builder', () => {
  it('topN_cap: returns at most 100 candidates', () => {
    const many = Array.from({ length: 140 }, (_, i) => rawMarket({
      marketId: `m-${i}`,
      eventId: `e-${i}`,
      yesPrice: 0.2 + ((i % 10) * 0.01),
      volume24h: 10_000 + i,
      liquidity: 20_000 + i,
    }));

    const { candidates } = buildModule1Candidates(many, {
      now: NOW,
      maxCandidates: 100,
      minTarget: 50,
    });
    assert.equal(candidates.length, 100);
  });

  it('fallback_relaxed_mode_guard: uses relaxed config when strict too small', () => {
    const input = [
      rawMarket({ marketId: 'strict-1', eventId: 'strict-1', yesPrice: 0.18 }),
      rawMarket({ marketId: 'strict-2', eventId: 'strict-2', yesPrice: 0.22 }),
      rawMarket({ marketId: 'relaxed-1', eventId: 'relaxed-1', spreadPct: 0.07, yesPrice: 0.57 }),
    ];

    const strictOnly = buildModule1Candidates(input, {
      now: NOW,
      minTarget: 1,
      maxCandidates: 100,
      config: FILTER_CONFIG,
      relaxedConfig: null,
    });
    assert.equal(strictOnly.stats.usedRelaxed, false);

    const withFallback = buildModule1Candidates(input, {
      now: NOW,
      minTarget: 50,
      maxCandidates: 100,
      config: FILTER_CONFIG,
      relaxedConfig: RELAXED_FILTER_CONFIG,
    });
    assert.equal(withFallback.stats.usedRelaxed, true);
    assert.ok(withFallback.candidates.some(c => c.marketId === 'relaxed-1'));
  });

  it('output_shape_contract includes module1 fields', () => {
    const { candidates } = buildModule1Candidates([rawMarket()], {
      now: NOW,
      minTarget: 1,
      maxCandidates: 100,
    });

    assert.equal(candidates.length, 1);
    const c = candidates[0];
    assert.equal(typeof c.marketId, 'string');
    assert.equal(typeof c.currentPrice, 'number');
    assert.equal(typeof c.metadata.isActive, 'boolean');
    assert.equal(typeof c.metadata.acceptingOrders, 'boolean');
    assert.ok('spreadPct' in c);
    assert.ok('liquidity' in c);
    assert.ok('daysToExpiry' in c);
  });
});

describe('module1 helper computations', () => {
  it('computeSpreadPct uses bid/ask fallback', () => {
    const spread = computeSpreadPct({ bestBid: 0.19, bestAsk: 0.2 });
    assert.ok(Math.abs(spread - 0.05) < 1e-9);
  });

  it('computeDaysToExpiry returns fractional days', () => {
    const days = computeDaysToExpiry(isoInDays(10), NOW);
    assert.ok(days > 9.99 && days < 10.01);
  });
});
