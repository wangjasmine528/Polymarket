import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePolymarketSnapshotJsonl } from '../scripts/_polymarket-smart-money.mjs';
import {
  enrichCandidatesWithModules234,
  enrichCandidatesWithModules234Async,
  loadOptionalPolymarketSnapshotJsonl,
} from '../scripts/_polymarket-seed-enrichment.mjs';

describe('polymarket seed enrichment', () => {
  it('loadOptionalPolymarketSnapshotJsonl returns loaded=false for missing file', async () => {
    const r = await loadOptionalPolymarketSnapshotJsonl('/nonexistent/path/xyz.jsonl');
    assert.equal(r.loaded, false);
    assert.equal(r.records.length, 0);
  });

  it('enriches polymarket candidate when snapshot contains marketId', () => {
    const jsonl = [
      JSON.stringify({
        sampledAt: 1000,
        markets: [{ marketId: 'm1', question: 'Q?', pYes: 0.22, volume: '1000' }],
      }),
      JSON.stringify({
        sampledAt: 2000,
        markets: [{ marketId: 'm1', question: 'Q?', pYes: 0.24, volume: '1100' }],
      }),
    ].join('\n');
    const records = parsePolymarketSnapshotJsonl(jsonl);
    const candidates = [
      {
        marketId: 'm1',
        eventId: 'e1',
        title: 'Q?',
        source: 'polymarket',
        side: 'yes',
        currentPrice: 0.25,
        yesPrice: 25,
        noPrice: 75,
        volume24h: 8000,
        liquidity: 12000,
        spreadPct: 0.02,
        daysToExpiry: 30,
        endDate: '2026-12-31',
        url: 'https://polymarket.com/event/x',
        tags: [],
        metadata: {},
      },
    ];
    const { candidates: out, stats } = enrichCandidatesWithModules234(candidates, records, {
      smartMoneyOpts: { minBars: 1, minSignals: 99 },
    });
    assert.equal(stats.smartMoneyAttached, 1);
    assert.equal(out[0].smartMoney.available, true);
    assert.equal(out[0].smartMoney.marketId, 'm1');
    assert.equal(out[0].probabilityEstimate.mode, 'seed_degraded');
    assert.ok(out[0].probabilityEstimate.pTrue >= 0 && out[0].probabilityEstimate.pTrue <= 1);
    assert.equal(out[0].agentValidation.mode, 'stub');
    assert.ok(['buy', 'skip', 'short'].includes(out[0].agentValidation.judge.action));
  });

  it('async LLM path uses Claude parse + module4 judge (mocked callLlm)', async () => {
    let calls = 0;
    const callLlm = async ({ user }) => {
      calls += 1;
      if (user.includes('请分析')) {
        return JSON.stringify({
          probability: 0.52,
          reasoning: ['r1'],
          uncertainty: 'u',
          confidence: 'medium',
        });
      }
      if (user.includes('支持该腿上涨')) {
        return JSON.stringify({ stance: 'medium', thesis: ['t1'], risks: ['x'] });
      }
      if (user.includes('反对当前定价')) {
        return JSON.stringify({ stance: 'weak', thesis: ['t2'], risks: [] });
      }
      return JSON.stringify({
        action: 'skip',
        edge: 0.01,
        rationale: 'mock',
        kellyFraction: 0,
        positionUsd: 0,
      });
    };

    const candidates = [
      {
        marketId: 'm1',
        eventId: 'e1',
        title: 'Test Q?',
        source: 'polymarket',
        side: 'yes',
        currentPrice: 0.4,
        yesPrice: 40,
        noPrice: 60,
        volume24h: 8000,
        liquidity: 12000,
        spreadPct: 0.02,
        daysToExpiry: 30,
        endDate: '2026-12-31',
        url: 'https://polymarket.com/event/x',
        tags: [],
        metadata: {},
      },
    ];
    const { candidates: out, stats } = await enrichCandidatesWithModules234Async(candidates, [], {
      useLlm: true,
      callLlm,
      llmMaxCandidates: 1,
      llmDelayMs: 0,
    });
    assert.equal(stats.useLlm, true);
    assert.equal(stats.llmCandidatesSucceeded, 1);
    assert.equal(out[0].probabilityEstimate.mode, 'llm_fused');
    assert.equal(out[0].agentValidation.mode, 'llm');
    assert.equal(calls, 4);
  });

  it('marks non-polymarket candidate smartMoney unavailable', () => {
    const { candidates: out } = enrichCandidatesWithModules234(
      [
        {
          marketId: 'KXHIGHNY-25',
          eventId: 'k1',
          title: 'Kalshi m',
          source: 'kalshi',
          side: 'yes',
          currentPrice: 0.4,
          yesPrice: 40,
          noPrice: 60,
          volume24h: 9000,
          liquidity: 10000,
          spreadPct: 0.02,
          daysToExpiry: 20,
          endDate: null,
          url: 'https://kalshi.com/x',
          tags: [],
          metadata: {},
        },
      ],
      [],
    );
    assert.equal(out[0].smartMoney.available, false);
    assert.equal(out[0].smartMoney.reason, 'not_polymarket_source');
    assert.equal(out[0].probabilityEstimate.mode, 'seed_degraded');
  });
});
