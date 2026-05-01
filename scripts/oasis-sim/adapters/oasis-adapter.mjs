// @ts-check

/**
 * @typedef {import('../types.mjs').AgentTask} AgentTask
 * @typedef {import('../types.mjs').AgentResult} AgentResult
 * @typedef {import('../types.mjs').OrchestrationContext} OrchestrationContext
 * @typedef {import('../types.mjs').OrchestrationTrace} OrchestrationTrace
 */

/**
 * @callback OasisAgentHandler
 * @param {OrchestrationContext} context
 * @param {AgentTask} task
 * @returns {Promise<AgentResult>}
 */

export class OasisMockAdapter {
  constructor() {
    /** @type {Map<string, OasisAgentHandler>} */
    this.registry = new Map();
    /** @type {OrchestrationTrace[]} */
    this.trace = [];
    this.step = 0;
  }

  /**
   * @param {string} agentName
   * @param {OasisAgentHandler} handler
   */
  registerAgent(agentName, handler) {
    this.registry.set(agentName, handler);
  }

  /**
   * @returns {OrchestrationTrace[]}
   */
  emitTrace() {
    return this.trace.slice();
  }

  /**
   * @param {OrchestrationContext} context
   * @param {AgentTask[]} tasks
   * @returns {Promise<AgentResult[]>}
   */
  async runWorkflow(context, tasks) {
    /** @type {AgentResult[]} */
    const results = [];
    for (const task of tasks) {
      const handler = this.registry.get(task.agent);
      if (!handler) {
        results.push({
          taskId: task.id,
          agent: task.agent,
          ok: false,
          output: {},
          warnings: [`No handler registered for agent ${task.agent}`],
        });
        continue;
      }
      const startedAt = Date.now();
      const result = await handler(context, task);
      const endedAt = Date.now();
      results.push(result);
      this.trace.push({
        step: this.step++,
        agent: task.agent,
        taskId: task.id,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        inputSummary: summarizeTaskInput(task),
        outputSummary: summarizeTaskOutput(result),
        warnings: result.warnings ?? [],
      });
    }
    return results;
  }
}

/**
 * @param {AgentTask} task
 */
function summarizeTaskInput(task) {
  const keys = Object.keys(task.payload ?? {});
  return keys.length > 0 ? `keys=${keys.join(',')}` : 'empty-input';
}

/**
 * @param {AgentResult} result
 */
function summarizeTaskOutput(result) {
  const keys = Object.keys(result.output ?? {});
  const status = result.ok ? 'ok' : 'failed';
  return keys.length > 0 ? `${status}; keys=${keys.join(',')}` : `${status}; empty-output`;
}
