// @ts-check

import { scoreActors } from '../../regional-snapshot/actor-scoring.mjs';

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
export async function runAdjudicatorAgent(context, task) {
  const candidates = /** @type {PredictedEvent[]} */ (task.payload?.candidates ?? []);
  const { actors } = scoreActors(context.regionId, context.sources);
  const topLeverage = actors.slice(0, 3).map((actor) => actor.name);
  const warnings = [];

  /** @type {Map<string, PredictedEvent>} */
  const merged = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.eventType}:${candidate.location}:${candidate.horizon}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      ...existing,
      probability: round(Math.max(existing.probability, candidate.probability)),
      confidence: round(Math.min(1, Math.max(existing.confidence, candidate.confidence))),
      evidenceIds: [...new Set([...(existing.evidenceIds ?? []), ...(candidate.evidenceIds ?? [])])].slice(0, 10),
      rationale: `${existing.rationale} ${candidate.rationale}`.trim(),
    });
  }

  const events = [...merged.values()]
    .map((event) => {
      const actorBoost = topLeverage.length > 0 ? 0.03 : 0;
      return {
        ...event,
        confidence: round(Math.min(1, event.confidence + actorBoost)),
        rationale: topLeverage.length > 0
          ? `${event.rationale} Top actors: ${topLeverage.join(', ')}.`
          : event.rationale,
      };
    })
    .sort((a, b) => b.probability - a.probability || b.confidence - a.confidence);

  if (events.length === 0) {
    warnings.push('No final events after adjudication');
  }

  return {
    taskId: task.id,
    agent: 'adjudicator',
    ok: true,
    output: {
      events,
      actorCount: actors.length,
      topLeverage,
    },
    warnings,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
