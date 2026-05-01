// @ts-check

import { collectEvidence } from '../../regional-snapshot/evidence-collector.mjs';

/**
 * @typedef {import('../types.mjs').OrchestrationContext} OrchestrationContext
 * @typedef {import('../types.mjs').AgentTask} AgentTask
 * @typedef {import('../types.mjs').AgentResult} AgentResult
 * @typedef {import('../types.mjs').PredictedEvent} PredictedEvent
 */

/**
 * @param {OrchestrationContext} context
 * @param {AgentTask} task
 * @returns {Promise<AgentResult>}
 */
export async function runEvidenceAgent(context, task) {
  const candidates = /** @type {PredictedEvent[]} */ (task.payload?.candidates ?? []);
  const evidence = collectEvidence(context.regionId, context.sources);
  const warnings = [];
  if (evidence.length === 0) {
    warnings.push('No evidence items collected from current source keys');
  }

  // collectEvidence() already scopes items to this regionId; no theater re-filter.
  const topEvidence = evidence.slice(0, 6);
  const enriched = candidates.map((candidate) => {
    const matched = topEvidence;
    const evidenceIds = matched.map((item) => String(item.id));
    const confidenceBoost = matched.length === 0 ? 0 : Math.min(0.2, matched.length * 0.03);
    return {
      ...candidate,
      confidence: round(Math.min(1, candidate.confidence + confidenceBoost)),
      rationale: `${candidate.rationale} Evidence linked: ${matched.length}.`,
      evidenceIds: [...new Set([...(candidate.evidenceIds ?? []), ...evidenceIds])].slice(0, 8),
    };
  });

  return {
    taskId: task.id,
    agent: 'evidence',
    ok: true,
    output: {
      candidates: enriched,
      evidenceCount: evidence.length,
    },
    warnings,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
