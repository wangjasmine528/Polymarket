import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  calculateLimitPriceProbability,
  buildUserOrderFromDecision,
} from '../scripts/_polymarket-execution.mjs';

describe('module5 execution pure', () => {
  it('calculateLimitPriceProbability raises buy cap and lowers sell floor', () => {
    const buy = calculateLimitPriceProbability(0.4, 'BUY', 0.01);
    assert.ok(buy > 0.4 && buy < 1);
    const sell = calculateLimitPriceProbability(0.4, 'SELL', 0.01);
    assert.ok(sell < 0.4 && sell > 0);
  });

  it('buildUserOrderFromDecision builds BUY order', () => {
    const r = buildUserOrderFromDecision({
      action: 'buy',
      token_id: '123',
      market_price: 0.5,
      clobSide: 'BUY',
      position_size: 2,
      slippage_tolerance: 0.005,
    });
    assert.equal(r.skip, false);
    assert.equal(r.userOrder.tokenID, '123');
    assert.equal(r.userOrder.side, 'BUY');
    assert.ok(r.userOrder.price > 0.5);
    assert.equal(r.userOrder.size, 2);
  });

  it('buildUserOrderFromDecision skips without token', () => {
    const r = buildUserOrderFromDecision({
      action: 'buy',
      market_price: 0.5,
      clobSide: 'BUY',
      position_size: 1,
    });
    assert.equal(r.skip, true);
  });
});
