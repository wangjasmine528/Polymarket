import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  linearRegression,
  detectSlowGrind,
  detectVolumeTrend,
  detectNarrowingPullback,
  detectBreakout,
  detectVolumeSpike,
  detectSmartMoneySignals,
  explainSmartMoneyInsufficientData,
  parsePolymarketSnapshotJsonl,
  buildMarketSeriesFromSnapshots,
  detectSmartMoneyFromSnapshots,
  SMART_MONEY_DEFAULT_MIN_BARS,
} from '../scripts/_polymarket-smart-money.mjs';

function upwardSeries(length, start = 0.2, drift = 0.001) {
  const out = [];
  for (let i = 0; i < length; i++) out.push(start + i * drift);
  return out;
}

describe('smart money math helpers', () => {
  it('linearRegression returns positive slope and high r2 for linear sequence', () => {
    const { slope, r2 } = linearRegression([1, 2, 3, 4, 5, 6]);
    assert.ok(slope > 0);
    assert.ok(r2 > 0.99);
  });
});

describe('smart money signals', () => {
  it('detectSlowGrind triggers on smooth >5% rise with small candles', () => {
    const closes = upwardSeries(130, 0.2, 0.0002);
    assert.equal(detectSlowGrind(closes), true);
  });

  it('detectSlowGrind does not trigger on sharp jumpy moves', () => {
    const closes = upwardSeries(130, 0.2, 0.0002);
    closes[90] = closes[89] * 1.04;
    assert.equal(detectSlowGrind(closes), false);
  });

  it('detectVolumeTrend triggers when slope>0 and r2>0.5', () => {
    const volumes = upwardSeries(80, 100, 2);
    assert.equal(detectVolumeTrend(volumes), true);
  });

  it('detectNarrowingPullback triggers when recent drawdown narrows', () => {
    const early = Array.from({ length: 60 }, (_, i) => {
      if (i < 30) return 1 + i * 0.003;
      return 1.09 - (i - 30) * 0.006;
    });
    const recent = Array.from({ length: 60 }, (_, i) => {
      if (i < 30) return 0.91 + i * 0.002;
      return 0.97 - (i - 30) * 0.0015;
    });
    const closes = early.concat(recent);
    assert.equal(detectNarrowingPullback(closes), true);
  });

  it('detectBreakout triggers when MA60/MA120 converge and last > MA60*1.03', () => {
    const base = Array.from({ length: 119 }, () => 1);
    base.push(1.05);
    assert.equal(detectBreakout(base), true);
  });

  it('detectVolumeSpike triggers on 5-bar average > 2.5x baseline', () => {
    const volumes = Array.from({ length: 60 }, () => 100).concat([350, 360, 340, 355, 345]);
    assert.equal(detectVolumeSpike(volumes), true);
  });

  it('detectSmartMoneySignals triggers with 2+ active signals', () => {
    const closes = upwardSeries(130, 0.2, 0.0002);
    const volumes = Array.from({ length: 60 }, () => 100).concat([350, 360, 340, 355, 345]);
    const result = detectSmartMoneySignals(closes, volumes);
    assert.equal(result.triggered, true);
    assert.ok(result.score >= 2);
  });
});

describe('snapshot parsing and series build', () => {
  it('parses jsonl lines and builds market series with volume deltas', () => {
    const jsonl = [
      JSON.stringify({
        sampledAt: 1000,
        markets: [{ marketId: 'm1', question: 'Q1', pYes: 0.2, volume: '100' }],
      }),
      JSON.stringify({
        sampledAt: 2000,
        markets: [{ marketId: 'm1', question: 'Q1', pYes: 0.22, volume: '130' }],
      }),
    ].join('\n');

    const records = parsePolymarketSnapshotJsonl(jsonl);
    assert.equal(records.length, 2);

    const series = buildMarketSeriesFromSnapshots(records);
    assert.equal(series.length, 1);
    assert.deepEqual(series[0].closes, [0.2, 0.22]);
    assert.deepEqual(series[0].volumes, [0, 30]);
  });

  it('detectSmartMoneyFromSnapshots marks insufficient bars as not triggered', () => {
    const records = parsePolymarketSnapshotJsonl(JSON.stringify({
      sampledAt: 1000,
      markets: [{ marketId: 'm1', question: 'Q1', pYes: 0.2, volume: '100' }],
    }));
    const result = detectSmartMoneyFromSnapshots(records, { minBars: SMART_MONEY_DEFAULT_MIN_BARS });
    assert.equal(result.length, 1);
    assert.equal(result[0].detection.triggered, false);
    assert.equal(result[0].bars, 1);
    assert.ok(result[0].gateReason.includes('minBars'));
  });

  it('explainSmartMoneyInsufficientData flags short series per signal', () => {
    const rows = explainSmartMoneyInsufficientData([0.2, 0.21], [0, 100]);
    const skippedIds = rows.filter((r) => r.skipped).map((r) => r.id).sort();
    assert.deepEqual(skippedIds, ['breakout', 'narrow_pullback', 'slow_grind', 'vol_spike', 'vol_trend']);
  });
});
