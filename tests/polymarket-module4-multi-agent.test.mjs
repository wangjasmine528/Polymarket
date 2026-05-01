import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  kellyPositionUsd,
  kellySafeFraction,
  oppositeLegProbabilities,
  formatModule4Context,
  buildBullUserPrompt,
  extractFirstJsonObject,
  parseDebateAgentJson,
  parseJudgeDecisionJson,
  stubModule4Decision,
  runModule4LlmPipeline,
} from '../scripts/_polymarket-multi-agent.mjs';

describe('module4 Kelly (design doc)', () => {
  it('returns 0 when p_true <= p_market', () => {
    assert.equal(kellyPositionUsd(0.4, 0.5, 10_000), 0);
  });

  it('caps quarter-Kelly at max_fraction * bankroll', () => {
    const usd = kellyPositionUsd(0.6, 0.44, 10_000, 0.05);
    assert.ok(usd > 0);
    assert.equal(usd, 500);
    assert.ok(Math.abs(kellySafeFraction(0.6, 0.44, 0.05) - 0.05) < 1e-9);
  });
});

describe('module4 helpers', () => {
  it('oppositeLegProbabilities for yes/no', () => {
    const oYes = oppositeLegProbabilities('yes', 0.6, 0.55);
    assert.equal(oYes.pWin, 0.4);
    assert.ok(Math.abs(oYes.pMarket - 0.45) < 1e-9);
    const oNo = oppositeLegProbabilities('no', 0.6, 0.35);
    assert.equal(oNo.pWin, 0.6);
    assert.ok(Math.abs(oNo.pMarket - 0.65) < 1e-9);
  });

  it('formatModule4Context includes smart money and title', () => {
    const text = formatModule4Context({
      title: 'T1',
      side: 'yes',
      currentPrice: 0.3,
      pTrue: 0.4,
      smartMoney: { triggered: false, score: 0, signals: [] },
    });
    assert.ok(text.includes('T1'));
    assert.ok(text.includes('模块2'));
  });

  it('buildBullUserPrompt references JSON-only output', () => {
    const p = buildBullUserPrompt('CTX');
    assert.ok(p.includes('CTX'));
    assert.ok(p.includes('只输出 JSON'));
  });

  it('extractFirstJsonObject parses fenced json', () => {
    const obj = extractFirstJsonObject('prefix\n```json\n{"a":1}\n```\n');
    assert.deepEqual(obj, { a: 1 });
  });

  it('parseDebateAgentJson and parseJudgeDecisionJson', () => {
    const d = parseDebateAgentJson({ stance: 'STRONG', thesis: ['x'], risks: ['y'] });
    assert.equal(d.stance, 'strong');
    const j = parseJudgeDecisionJson({
      action: 'buy',
      edge: 0.1,
      rationale: 'ok',
      kellyFraction: 0.02,
      positionUsd: 200,
    });
    assert.equal(j.action, 'buy');
  });
});

describe('module4 stub judge', () => {
  it('recommends buy when edge clears threshold and Kelly > 0', () => {
    const out = stubModule4Decision(
      { title: 'x', side: 'yes', currentPrice: 0.44, pTrue: 0.56 },
      { bankroll: 10_000, edgeMin: 0.02 },
    );
    assert.equal(out.judge.action, 'buy');
    assert.ok(out.judge.positionUsd > 0);
  });

  it('skips when edge is near zero', () => {
    const out = stubModule4Decision(
      { title: 'x', side: 'yes', currentPrice: 0.5, pTrue: 0.5 },
      { edgeMin: 0.02 },
    );
    assert.equal(out.judge.action, 'skip');
  });

  it('recommends short when current leg overpriced and opposite has edge', () => {
    const out = stubModule4Decision(
      { title: 'x', side: 'yes', currentPrice: 0.75, pTrue: 0.25 },
      { bankroll: 10_000, edgeMin: 0.02 },
    );
    assert.equal(out.judge.action, 'short');
    assert.ok(out.judge.positionUsd > 0);
  });
});

describe('module4 LLM pipeline (mocked)', () => {
  it('runs bull, bear, judge via injected callLlm', async () => {
    let n = 0;
    const callLlm = async () => {
      n += 1;
      if (n === 1) {
        return JSON.stringify({ stance: 'strong', thesis: ['a'], risks: ['r'] });
      }
      if (n === 2) {
        return JSON.stringify({ stance: 'weak', thesis: ['b'], risks: [] });
      }
      return JSON.stringify({
        action: 'buy',
        edge: 0.12,
        rationale: 'mock',
        kellyFraction: 0.03,
        positionUsd: 300,
      });
    };

    const out = await runModule4LlmPipeline(
      { title: 'Ev', side: 'yes', currentPrice: 0.44, pTrue: 0.58 },
      callLlm,
      { bankroll: 10_000 },
    );
    assert.equal(out.mode, 'llm');
    assert.equal(out.judge.action, 'buy');
    assert.equal(n, 3);
  });
});
