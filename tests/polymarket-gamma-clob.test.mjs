import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseClobTokenIds,
  pickTokenIdForOutcome,
  inferMidFromGammaOutcomePrices,
} from '../scripts/_polymarket-gamma-clob.mjs';

describe('gamma clob token helpers', () => {
  it('parseClobTokenIds parses JSON string array', () => {
    const m = { clobTokenIds: '["111","222"]' };
    const { yesTokenId, noTokenId } = parseClobTokenIds(m);
    assert.equal(yesTokenId, '111');
    assert.equal(noTokenId, '222');
  });

  it('pickTokenIdForOutcome selects yes or no', () => {
    const m = { clobTokenIds: ['a', 'b'] };
    assert.equal(pickTokenIdForOutcome(m, 'yes'), 'a');
    assert.equal(pickTokenIdForOutcome(m, 'no'), 'b');
  });

  it('inferMidFromGammaOutcomePrices parses outcomePrices', () => {
    const m = { outcomePrices: '[0.52,0.48]' };
    assert.ok(Math.abs((inferMidFromGammaOutcomePrices(m, 'yes') ?? 0) - 0.52) < 1e-9);
    assert.ok(Math.abs((inferMidFromGammaOutcomePrices(m, 'no') ?? 0) - 0.48) < 1e-9);
  });
});
