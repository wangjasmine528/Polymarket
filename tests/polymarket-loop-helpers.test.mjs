import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  outcomeAndRefPriceForJudge,
  candidatePassesAutoExecFilters,
  sharesFromPositionUsd,
  pickFirstAutoExecCandidate,
} from '../scripts/_polymarket-loop-helpers.mjs';

describe('polymarket loop helpers', () => {
  it('outcomeAndRefPriceForJudge buy uses module1 side', () => {
    const r = outcomeAndRefPriceForJudge(
      { side: 'yes', currentPrice: 0.35, yesPrice: 35, noPrice: 65 },
      'buy',
    );
    assert.deepEqual(r, { outcome: 'yes', refMarketPrice01: 0.35 });
  });

  it('outcomeAndRefPriceForJudge short uses opposite with yesPrice', () => {
    const r = outcomeAndRefPriceForJudge(
      { side: 'no', currentPrice: 0.4, yesPrice: 60, noPrice: 40 },
      'short',
    );
    assert.equal(r?.outcome, 'yes');
    assert.ok(r && Math.abs(r.refMarketPrice01 - 0.6) < 1e-9);
  });

  it('candidatePassesAutoExecFilters respects actions and min usd', () => {
    const c = {
      source: 'polymarket',
      side: 'yes',
      currentPrice: 0.3,
      yesPrice: 30,
      noPrice: 70,
      agentValidation: { judge: { action: 'buy', positionUsd: 50, edge: 0.05 } },
    };
    const ok = candidatePassesAutoExecFilters(c, { actions: ['buy'], minPositionUsd: 1 });
    assert.equal(ok.ok, true);
    const skip = candidatePassesAutoExecFilters(c, { actions: ['short'], minPositionUsd: 1 });
    assert.equal(skip.ok, false);
  });

  it('sharesFromPositionUsd floors by price', () => {
    assert.equal(sharesFromPositionUsd(10, 0.5, { minShares: 1, maxShares: 100 }), 20);
    assert.equal(sharesFromPositionUsd(0.4, 0.5, { minShares: 1, maxShares: 100 }), 0);
  });

  it('pickFirstAutoExecCandidate returns first match', () => {
    const a = {
      source: 'kalshi',
      agentValidation: { judge: { action: 'buy', positionUsd: 100, edge: 0.1 } },
    };
    const b = {
      source: 'polymarket',
      side: 'yes',
      currentPrice: 0.2,
      yesPrice: 20,
      noPrice: 80,
      agentValidation: { judge: { action: 'buy', positionUsd: 20, edge: 0.03 } },
    };
    const hit = pickFirstAutoExecCandidate([a, b], { maxScan: 10 });
    assert.ok(hit);
    assert.equal(hit.candidate, b);
  });
});
