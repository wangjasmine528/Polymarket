/** 与 detectSmartMoneyFromSnapshots 默认门槛一致：价格类信号需要 120 根 closes。 */
export const SMART_MONEY_DEFAULT_MIN_BARS = 120;

/** 各子检测对序列长度的硬要求（不足则不可能为 true）。 */
export const SMART_MONEY_WINDOW_REQUIREMENTS = {
  slow_grind: { minCloses: 120, minVolumes: 0 },
  vol_trend: { minCloses: 0, minVolumes: 60 },
  narrow_pullback: { minCloses: 120, minVolumes: 0 },
  breakout: { minCloses: 120, minVolumes: 0 },
  vol_spike: { minCloses: 0, minVolumes: 65 },
};

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function safeSlice(values, count) {
  if (!Array.isArray(values) || values.length < count) return null;
  return values.slice(values.length - count);
}

export function linearRegression(values) {
  if (!Array.isArray(values) || values.length < 2) return { slope: 0, r2: 0 };
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    const dy = values[i] - yMean;
    num += dx * dy;
    den += dx * dx;
  }
  if (den === 0) return { slope: 0, r2: 0 };
  const slope = num / den;
  const intercept = yMean - slope * xMean;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * i + intercept;
    const err = values[i] - pred;
    ssRes += err * err;
    const centered = values[i] - yMean;
    ssTot += centered * centered;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - (ssRes / ssTot));
  return { slope, r2 };
}

function maxSingleReturnAbs(values) {
  let maxRet = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (!Number.isFinite(prev) || prev <= 0) continue;
    const ret = Math.abs((values[i] - prev) / prev);
    if (ret > maxRet) maxRet = ret;
  }
  return maxRet;
}

function maxDrawdown(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  let peak = values[0];
  let drawdown = 0;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > drawdown) drawdown = dd;
    }
  }
  return drawdown;
}

export function detectSlowGrind(closes) {
  const slice120 = safeSlice(closes, 120);
  if (!slice120 || slice120[0] <= 0) return false;
  const totalChange = (slice120[slice120.length - 1] - slice120[0]) / slice120[0];
  const maxSingle = maxSingleReturnAbs(slice120);
  return totalChange > 0.05 && maxSingle < 0.015;
}

export function detectVolumeTrend(volumes) {
  const tail60 = safeSlice(volumes, 60);
  if (!tail60) return false;
  const { slope, r2 } = linearRegression(tail60);
  return slope > 0 && r2 > 0.5;
}

export function detectNarrowingPullback(closes) {
  const slice120 = safeSlice(closes, 120);
  if (!slice120) return false;
  const half = Math.floor(slice120.length / 2);
  const early = slice120.slice(0, half);
  const recent = slice120.slice(half);
  const earlyDd = maxDrawdown(early);
  const recentDd = maxDrawdown(recent);
  if (earlyDd <= 0) return false;
  return recentDd < earlyDd * 0.6;
}

export function detectBreakout(closes) {
  const tail60 = safeSlice(closes, 60);
  const tail120 = safeSlice(closes, 120);
  if (!tail60 || !tail120) return false;
  const ma60 = mean(tail60);
  const ma120 = mean(tail120);
  if (ma120 <= 0) return false;
  const bias = Math.abs(ma60 - ma120) / ma120;
  const last = tail120[tail120.length - 1];
  return bias < 0.02 && last > ma60 * 1.03;
}

export function detectVolumeSpike(volumes) {
  const tail65 = safeSlice(volumes, 65);
  if (!tail65) return false;
  const recentAvg = mean(tail65.slice(-5));
  const baselineAvg = mean(tail65.slice(0, 60));
  if (baselineAvg <= 0) return false;
  return recentAvg > baselineAvg * 2.5;
}

export function detectSmartMoneySignals(closes, volumes, options = {}) {
  const minSignals = options.minSignals ?? 2;
  const signals = [];

  if (detectSlowGrind(closes)) signals.push('slow_grind');
  if (detectVolumeTrend(volumes)) signals.push('vol_trend');
  if (detectNarrowingPullback(closes)) signals.push('narrow_pullback');
  if (detectBreakout(closes)) signals.push('breakout');
  if (detectVolumeSpike(volumes)) signals.push('vol_spike');

  return {
    triggered: signals.length >= minSignals,
    score: signals.length,
    signals,
  };
}

/**
 * 因「数据点不够」导致某条信号不可能触发的说明（中文，供 CLI 打印）。
 * 不判断形态是否满足，只判断窗口长度。
 */
export function explainSmartMoneyInsufficientData(closes, volumes) {
  const nC = Array.isArray(closes) ? closes.length : 0;
  const nV = Array.isArray(volumes) ? volumes.length : 0;
  /** @type {Array<{ id: string, skipped: boolean, reason: string }>} */
  const rows = [];

  const req = SMART_MONEY_WINDOW_REQUIREMENTS;
  for (const id of Object.keys(req)) {
    const { minCloses, minVolumes } = req[id];
    const shortC = minCloses > 0 && nC < minCloses;
    const shortV = minVolumes > 0 && nV < minVolumes;
    if (shortC || shortV) {
      const parts = [];
      if (shortC) parts.push(`closes 需要≥${minCloses}，当前 ${nC}`);
      if (shortV) parts.push(`volumes 需要≥${minVolumes}，当前 ${nV}`);
      rows.push({ id, skipped: true, reason: `数据不足：${parts.join('；')}` });
    } else {
      rows.push({ id, skipped: false, reason: '窗口长度已满足（是否触发仍取决于形态阈值）' });
    }
  }
  return rows;
}

export function parsePolymarketSnapshotJsonl(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && Array.isArray(parsed.markets)) records.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

export function buildMarketSeriesFromSnapshots(records) {
  /** @type {Map<string, { marketId: string, question: string, closes: number[], volumes: number[], sampledAt: number[], _lastCumulativeVolume?: number }>} */
  const seriesByMarket = new Map();

  for (const record of records) {
    const sampledAt = Number(record.sampledAt) || Date.parse(record.sampledAtIso || '') || Date.now();
    for (const market of record.markets ?? []) {
      const marketId = String(market.marketId ?? '');
      if (!marketId) continue;
      const close = Number(market.pYes ?? market.lastTradePrice);
      const cumulativeVol = Number(market.volume);
      if (!Number.isFinite(close) || close < 0 || close > 1) continue;
      if (!Number.isFinite(cumulativeVol) || cumulativeVol < 0) continue;

      if (!seriesByMarket.has(marketId)) {
        seriesByMarket.set(marketId, {
          marketId,
          question: String(market.question ?? ''),
          closes: [],
          volumes: [],
          sampledAt: [],
          _lastCumulativeVolume: undefined,
        });
      }

      const series = seriesByMarket.get(marketId);
      const prevCumulative = series._lastCumulativeVolume;
      const delta = prevCumulative == null ? 0 : Math.max(cumulativeVol - prevCumulative, 0);
      series.closes.push(close);
      series.volumes.push(delta);
      series.sampledAt.push(sampledAt);
      series._lastCumulativeVolume = cumulativeVol;
    }
  }

  return Array.from(seriesByMarket.values()).map(({ _lastCumulativeVolume, ...series }) => series);
}

export function detectSmartMoneyFromSnapshots(records, options = {}) {
  const minBars = options.minBars ?? SMART_MONEY_DEFAULT_MIN_BARS;
  const minSignals = options.minSignals ?? 2;
  const seriesList = buildMarketSeriesFromSnapshots(records);
  return seriesList.map((series) => {
    const enough = series.closes.length >= minBars && series.volumes.length >= minBars;
    const detection = enough
      ? detectSmartMoneySignals(series.closes, series.volumes, { minSignals })
      : { triggered: false, score: 0, signals: [] };
    const gateReason = enough
      ? ''
      : `数据不足：未达到运行门槛 minBars=${minBars}（当前 closes=${series.closes.length}，volumes=${series.volumes.length}），已跳过形态检测`;
    const insufficientBySignal = explainSmartMoneyInsufficientData(series.closes, series.volumes);
    return {
      marketId: series.marketId,
      question: series.question,
      bars: series.closes.length,
      volumeBars: series.volumes.length,
      detection,
      gateReason,
      insufficientBySignal,
    };
  });
}
