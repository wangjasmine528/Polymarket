// @ts-check

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { oasisScenarioLanesToPolymarketYes } from './market-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CALIBRATION_PATH = join(
  __dirname,
  '..',
  '..',
  'data',
  'polymarket',
  'oasis-d-calibration-weights.json',
);

/**
 * @typedef {{
 *   version: string
 *   intercept: number
 *   weights: { base: number; escalation: number; containment: number; fragmentation: number }
 *   ridgeLambda: number
 *   fittedAt: string
 *   nTrain: number
 *   trainMse: number
 * }} CalibrationWeights
 */

/**
 * @param {string} [path]
 * @returns {Promise<CalibrationWeights | null>}
 */
export async function loadCalibrationWeights(path = DEFAULT_CALIBRATION_PATH) {
  try {
    const raw = await readFile(path, 'utf8');
    /** @type {CalibrationWeights} */
    const w = JSON.parse(raw);
    if (!w?.weights || typeof w.intercept !== 'number') return null;
    return w;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, number>} laneProb
 * @param {CalibrationWeights} cal
 * @returns {number}
 */
function linearPHat(laneProb, cal) {
  const b = laneProb.base ?? 0;
  const e = laneProb.escalation ?? 0;
  const c = laneProb.containment ?? 0;
  const f = laneProb.fragmentation ?? 0;
  const z =
    cal.intercept +
    cal.weights.base * b +
    cal.weights.escalation * e +
    cal.weights.containment * c +
    cal.weights.fragmentation * f;
  return clip(z, 0.02, 0.98);
}

/**
 * @param {import('./types.mjs').PredictedEvent[]} events
 * @param {{ calibrationPath?: string }} [opts]
 */
export async function oasisLanesToPolymarketYesCalibrated(events, opts = {}) {
  const baseline = oasisScenarioLanesToPolymarketYes(events);
  const cal = await loadCalibrationWeights(opts.calibrationPath);
  if (!cal) {
    return {
      pHat: baseline.pHat,
      pHatBaseline: baseline.pHat,
      formulaVersion: baseline.formulaVersion,
      laneProb: baseline.laneProb,
      formulaNote: baseline.note,
      calibration: { applied: false },
    };
  }

  const pHat = round(linearPHat(baseline.laneProb, cal));
  return {
    pHat,
    pHatBaseline: baseline.pHat,
    formulaVersion: `${cal.version}|${baseline.formulaVersion}`,
    laneProb: baseline.laneProb,
    formulaNote: `${baseline.note} Calibrated ridge map to minimize historical MSE vs pMarketYes.`,
    calibration: {
      applied: true,
      fittedAt: cal.fittedAt,
      nTrain: cal.nTrain,
      trainMse: cal.trainMse,
      ridgeLambda: cal.ridgeLambda,
    },
  };
}

function clip(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
