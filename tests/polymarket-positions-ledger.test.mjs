import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  daysToExpiryFromEndDate,
  deriveHeldDays,
  upsertOpenPosition,
} from '../scripts/_polymarket-positions-ledger.mjs';

describe('positions ledger', () => {
  it('daysToExpiryFromEndDate returns positive when future', () => {
    const now = Date.UTC(2026, 4, 1, 12, 0, 0);
    const future = new Date(now + 5 * 86_400_000).toISOString();
    const d = daysToExpiryFromEndDate(future, now);
    assert.ok(d != null && d > 4.99 && d < 5.01);
  });

  it('deriveHeldDays from openedAtMs', () => {
    const now = Date.now();
    const h = deriveHeldDays({ openedAtMs: now - 2.5 * 86_400_000 }, now);
    assert.equal(h, 2);
  });

  it('upsertOpenPosition replaces same tokenId', () => {
    const a = upsertOpenPosition([], {
      tokenId: 't1',
      entryPrice01: 0.4,
      shares: 1,
      openedAtMs: 1,
    });
    assert.equal(a.length, 1);
    const b = upsertOpenPosition(a, {
      tokenId: 't1',
      entryPrice01: 0.5,
      shares: 2,
      openedAtMs: 2,
    });
    assert.equal(b.length, 1);
    assert.equal(b[0].entryPrice01, 0.5);
    assert.equal(b[0].shares, 2);
  });
});
