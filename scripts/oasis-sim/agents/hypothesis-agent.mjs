// @ts-check

import { buildScenarioSets } from '../../regional-snapshot/scenario-builder.mjs';

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
export async function runHypothesisAgent(context, task) {
  const triggers = /** @type {{active: any[], watching: any[]}} */ (task.payload?.triggers ?? { active: [], watching: [] });
  const scenarioSets = buildScenarioSets(context.regionId, context.sources, triggers);
  const selectedSet = scenarioSets.find((s) => s.horizon === context.horizon) ?? null;

  /** @type {PredictedEvent[]} */
  const candidates = [];
  const warnings = [];
  if (!selectedSet) {
    warnings.push(`No scenario set found for horizon ${context.horizon}`);
  } else {
    for (const lane of selectedSet.lanes ?? []) {
      if (Number(lane?.probability ?? 0) <= 0) continue;
      candidates.push({
        eventType: `scenario_${String(lane.name ?? 'base')}`,
        location: context.regionId,
        horizon: context.horizon,
        probability: round(Number(lane.probability ?? 0)),
        confidence: round(Math.min(1, 0.5 + Number(lane.probability ?? 0) * 0.4)),
        rationale: `Lane ${lane.name} derived from regional forecast alignment and trigger pressure.`,
        evidenceIds: Array.isArray(lane.trigger_ids) ? lane.trigger_ids.slice(0, 5).map(String) : [],
        inputs: ['forecast:predictions:v2'],
      });
    }
  }

  return {
    taskId: task.id,
    agent: 'hypothesis',
    ok: true,
    output: { candidates, scenarioCount: scenarioSets.length },
    warnings,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
