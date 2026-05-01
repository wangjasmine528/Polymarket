import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PROBABILITY_WEIGHTS,
  normalizeWeights,
  buildProbabilityPrompt,
  parseLlmProbabilityJson,
  sentimentToProbability,
  aggregateCorrelationProbability,
  fuseTrueProbability,
  evaluateCheaperSideEdge,
  buildSeedProbabilityEstimate,
  buildFusedProbabilityEstimateFromLlmParse,
} from '../scripts/_polymarket-probability.mjs';

describe('probability module weight handling', () => {
  it('normalizes custom weights to sum=1', () => {
    const weights = normalizeWeights({ llm: 4, baseRate: 2, news: 2.5, corr: 1.5 });
    const sum = weights.llm + weights.baseRate + weights.news + weights.corr;
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it('falls back to defaults when all custom weights invalid', () => {
    const weights = normalizeWeights({ llm: -1, baseRate: -1, news: -1, corr: -1 });
    assert.deepEqual(weights, DEFAULT_PROBABILITY_WEIGHTS);
  });
});

describe('probability module prompt and llm parsing', () => {
  it('builds chinese prompt with market implied probability', () => {
    const prompt = buildProbabilityPrompt({
      eventTitle: 'Test Event',
      eventDescription: 'desc',
      expiryDate: '2026-12-31',
      marketPrice: 0.27,
      newsContext: 'headline A; headline B',
    });
    assert.ok(prompt.includes('事件：Test Event'));
    assert.ok(prompt.includes('27.0%'));
    assert.ok(prompt.includes('"probability": 0.XX'));
  });

  it('parses llm json and sanitizes confidence/reasoning', () => {
    const parsed = parseLlmProbabilityJson(
      '{"probability":0.34,"reasoning":["a","b","c","d"],"uncertainty":"x","confidence":"HIGH"}',
    );
    assert.equal(parsed.probability, 0.34);
    assert.deepEqual(parsed.reasoning, ['a', 'b', 'c']);
    assert.equal(parsed.confidence, 'high');
  });
});

describe('probability module component transforms', () => {
  it('maps sentiment score to implied probability', () => {
    assert.ok(Math.abs(sentimentToProbability(0) - 0.5) < 1e-9);
    assert.ok(Math.abs(sentimentToProbability(1) - 0.85) < 1e-9);
    assert.ok(Math.abs(sentimentToProbability(-1) - 0.15) < 1e-9);
  });

  it('aggregates correlation probability with optional weights', () => {
    const p = aggregateCorrelationProbability([
      { probability: 0.6, weight: 2 },
      { probability: 0.3, weight: 1 },
    ]);
    assert.ok(p !== null);
    assert.ok(Math.abs(p - 0.5) < 1e-9);
  });
});

describe('buildFusedProbabilityEstimateFromLlmParse', () => {
  it('merges Claude P_llm with base/news/corr and computes edge', () => {
    const all = [
      { marketId: 'a', source: 'polymarket', yesPrice: 30, side: 'yes', currentPrice: 0.35 },
      { marketId: 'b', source: 'polymarket', yesPrice: 50, side: 'yes', currentPrice: 0.4 },
    ];
    const est = buildFusedProbabilityEstimateFromLlmParse(
      { probability: 0.55, confidence: 'high', reasoning: ['x'], uncertainty: 'u' },
      all[1],
      all,
    );
    assert.equal(est.mode, 'llm_fused');
    assert.ok(est.pTrue > 0 && est.pTrue <= 1);
    assert.equal(est.components.llm, 0.55);
    assert.ok(typeof est.edge.edge === 'number');
  });
});

describe('buildSeedProbabilityEstimate', () => {
  it('fuses without LLM and attaches edge for module1 candidate', () => {
    const all = [
      {
        marketId: 'a',
        source: 'polymarket',
        yesPrice: 40,
        side: 'yes',
        currentPrice: 0.4,
      },
      {
        marketId: 'b',
        source: 'polymarket',
        yesPrice: 60,
        side: 'no',
        currentPrice: 0.42,
      },
    ];
    const est = buildSeedProbabilityEstimate(all[1], all);
    assert.equal(est.mode, 'seed_degraded');
    assert.ok(est.pTrue >= 0 && est.pTrue <= 1);
    assert.ok(typeof est.edge.edge === 'number');
  });
});

describe('probability module fusion and edge', () => {
  it('fuses p_true with confidence anchoring', () => {
    const result = fuseTrueProbability(
      { llm: 0.7, baseRate: 0.4, news: 0.6, corr: 0.5 },
      { llmConfidence: 'high' },
    );
    assert.ok(result.pTrue > 0.5);
    assert.ok(result.pTrue <= 1);
    assert.ok(result.pTrueRaw > 0.5);
  });

  it('supports missing components by renormalizing effective weights', () => {
    const result = fuseTrueProbability(
      { llm: 0.62, baseRate: null, news: 0.58, corr: null },
      { weights: { llm: 0.4, baseRate: 0.2, news: 0.25, corr: 0.15 } },
    );
    assert.ok(result.pTrue > 0.5);
    assert.equal(result.components.baseRate, null);
    assert.equal(result.components.corr, null);
  });

  it('computes cheaper-side edge for yes/no correctly', () => {
    const yesEdge = evaluateCheaperSideEdge({ pTrue: 0.6, currentPrice: 0.45, side: 'yes' });
    assert.equal(yesEdge.hasEdge, true);
    assert.ok(yesEdge.edge > 0);

    const noEdge = evaluateCheaperSideEdge({ pTrue: 0.2, currentPrice: 0.6, side: 'no' });
    assert.equal(noEdge.hasEdge, true);
    assert.ok(noEdge.edge > 0);
  });
});
