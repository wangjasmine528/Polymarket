import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_RISK_RULES,
  evaluatePositionRisk,
  monitorPositions,
} from '../scripts/_polymarket-risk-manager.mjs';

describe('module6 risk manager', () => {
  it('near_expiry closes regardless of pnl', () => {
    const r = evaluatePositionRisk(
      { tokenId: 'a', entryPrice01: 0.5, daysToExpiry: 0.5, heldDays: 0 },
      0.55,
      { force_close_days: 1 },
    );
    assert.equal(r.action, 'close');
    assert.equal(r.reason, 'near_expiry');
  });

  it('stop_loss when pnl bad enough and min hold met', () => {
    const r = evaluatePositionRisk(
      { tokenId: 'a', entryPrice01: 0.5, heldDays: 2 },
      0.25,
      { stop_loss_pct: 0.4 },
    );
    assert.equal(r.action, 'close');
    assert.equal(r.reason, 'stop_loss');
  });

  it('min_days_to_hold blocks discretionary exit', () => {
    const r = evaluatePositionRisk(
      { tokenId: 'a', entryPrice01: 0.5, heldDays: 0 },
      0.2,
      { stop_loss_pct: 0.4, min_days_to_hold: 1 },
    );
    assert.equal(r.action, 'hold');
    assert.equal(r.reason, 'min_hold_days_not_met');
  });

  it('trailing_stop after arm profit and drawdown', () => {
    const r = evaluatePositionRisk(
      { tokenId: 'a', entryPrice01: 0.4, peakPrice01: 0.6, heldDays: 2 },
      0.5,
      { trailing_arm_pct: 0.2, trailing_stop_pct: 0.15 },
    );
    assert.equal(r.action, 'close');
    assert.equal(r.reason, 'trailing_stop');
  });

  it('take_profit', () => {
    const r = evaluatePositionRisk(
      { tokenId: 'a', entryPrice01: 0.25, heldDays: 2 },
      0.5,
      { take_profit_pct: 0.6 },
    );
    assert.equal(r.action, 'close');
    assert.equal(r.reason, 'take_profit');
  });

  it('monitorPositions maps prices', () => {
    const positions = [{ tokenId: 'x', entryPrice01: 0.5, heldDays: 2 }];
    const out = monitorPositions(positions, { x: 0.2 }, { stop_loss_pct: 0.4 });
    assert.equal(out[0].action, 'close');
    assert.equal(out[0].reason, 'stop_loss');
  });

  it('DEFAULT_RISK_RULES matches design doc defaults', () => {
    assert.equal(DEFAULT_RISK_RULES.stop_loss_pct, 0.4);
    assert.equal(DEFAULT_RISK_RULES.take_profit_pct, 0.6);
    assert.equal(DEFAULT_RISK_RULES.trailing_stop_pct, 0.15);
    assert.equal(DEFAULT_RISK_RULES.min_days_to_hold, 1);
    assert.equal(DEFAULT_RISK_RULES.force_close_days, 1);
  });
});
