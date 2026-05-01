// @ts-check

/**
 * @typedef {import('./types.mjs').PredictedEvent} PredictedEvent
 */

/**
 * Map normalized scenario lane probabilities (base / escalation / containment / fragmentation)
 * to a single implied P(Yes) for a binary market such as the US–Iran peace Polymarket.
 *
 * This is an explicit **placeholder** for Phase B alignment only — replace with
 * calibration / LLM adjudication in Phase D.
 *
 * @param {PredictedEvent[]} events
 * @returns {{ pHat: number; formulaVersion: string; laneProb: Record<string, number>; note: string }}
 */
export function oasisScenarioLanesToPolymarketYes(events) {
  const formulaVersion = 'b0-stability-vs-escalation-v1';
  /** @type {Record<string, number>} */
  const laneProb = {};
  for (const e of events) {
    const name = String(e.eventType).replace(/^scenario_/, '');
    laneProb[name] = Number(e.probability) || 0;
  }

  const base = laneProb.base ?? 0;
  const esc = laneProb.escalation ?? 0;
  const cont = laneProb.containment ?? 0;
  const frag = laneProb.fragmentation ?? 0;

  // stability in [-1, 1] when lane probs sum ~1
  const stability = base + cont - esc - 0.5 * frag;
  const raw = 0.5 + 0.35 * stability;
  const pHat = clip(raw, 0.02, 0.98);

  return {
    pHat: round(pHat),
    formulaVersion,
    laneProb,
    note:
      'Heuristic only: higher base+containment vs escalation+fragmentation raises pHat. Not calibrated to historical Polymarket.',
  };
}

function clip(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
