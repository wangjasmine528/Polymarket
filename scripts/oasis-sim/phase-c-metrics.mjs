// @ts-check

/**
 * @typedef {{ sampledAt: number; pHat: number; pMarketYes: number; marketSlug: string }} AlignmentPoint
 */

/**
 * @param {AlignmentPoint[]} points sorted ascending by sampledAt
 */
export function computePhaseCMetrics(points) {
  const valid = points.filter((p) => Number.isFinite(p.pHat) && Number.isFinite(p.pMarketYes));
  const n = valid.length;
  if (n === 0) {
    return {
      nSamples: 0,
      mae: null,
      rmse: null,
      mseVsMarket: null,
      meanGap: null,
      directionMatchRate: null,
      nDirectionPairs: 0,
      note: 'No rows with both pHat and pMarketYes',
    };
  }

  let sumAbs = 0;
  let sumSq = 0;
  let sumGap = 0;
  for (const p of valid) {
    const d = p.pHat - p.pMarketYes;
    sumAbs += Math.abs(d);
    sumSq += d * d;
    sumGap += d;
  }
  const mae = sumAbs / n;
  const mseVsMarket = sumSq / n;
  const rmse = Math.sqrt(mseVsMarket);
  const meanGap = sumGap / n;

  let dirMatches = 0;
  let dirTotal = 0;
  for (let i = 1; i < valid.length; i += 1) {
    const a = valid[i - 1];
    const b = valid[i];
    const dM = b.pMarketYes - a.pMarketYes;
    const dH = b.pHat - a.pHat;
    if (Math.abs(dM) < 1e-9 && Math.abs(dH) < 1e-9) continue;
    if (Math.abs(dM) < 1e-9 || Math.abs(dH) < 1e-9) {
      dirTotal += 1;
      continue;
    }
    dirTotal += 1;
    if (Math.sign(dM) === Math.sign(dH)) dirMatches += 1;
  }

  return {
    nSamples: n,
    mae: round(mae),
    rmse: round(rmse),
    mseVsMarket: round(mseVsMarket),
    meanGap: round(meanGap),
    directionMatchRate: dirTotal > 0 ? round(dirMatches / dirTotal) : null,
    nDirectionPairs: dirTotal,
    note:
      'mseVsMarket is mean squared error of pHat vs contemporaneous pMarketYes (calibration-style target), not Brier vs realized outcome.',
  };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}
