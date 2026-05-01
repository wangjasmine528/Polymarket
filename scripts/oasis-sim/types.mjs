// @ts-check

/**
 * @typedef {'24h' | '7d' | '30d'} ScenarioHorizon
 */

/**
 * @typedef {'hypothesis' | 'evidence' | 'adjudicator'} OasisAgentName
 */

/**
 * @typedef {{
 *   regionId: string
 *   horizon: ScenarioHorizon
 *   dryRun: boolean
 *   startedAt: number
 *   sources: Record<string, any>
 * }} OrchestrationContext
 */

/**
 * @typedef {{
 *   id: string
 *   agent: OasisAgentName
 *   payload: Record<string, any>
 * }} AgentTask
 */

/**
 * @typedef {{
 *   eventType: string
 *   location: string
 *   horizon: ScenarioHorizon
 *   probability: number
 *   confidence: number
 *   rationale: string
 *   evidenceIds: string[]
 *   inputs?: string[]
 * }} PredictedEvent
 */

/**
 * @typedef {{
 *   taskId: string
 *   agent: OasisAgentName
 *   ok: boolean
 *   output: Record<string, any>
 *   warnings?: string[]
 * }} AgentResult
 */

/**
 * @typedef {{
 *   step: number
 *   agent: OasisAgentName
 *   taskId: string
 *   startedAt: number
 *   endedAt: number
 *   durationMs: number
 *   inputSummary: string
 *   outputSummary: string
 *   warnings?: string[]
 * }} OrchestrationTrace
 */

/**
 * @typedef {{
 *   runMeta: {
 *     mode: 'oasis-mock-adapter'
 *     regionId: string
 *     horizon: ScenarioHorizon
 *     dryRun: boolean
 *     startedAt: number
 *     finishedAt: number
 *     durationMs: number
 *   }
 *   events: PredictedEvent[]
 *   trace: OrchestrationTrace[]
 *   warnings: string[]
 * }} OrchestrationOutput
 */

export const OASIS_SIM_MODE = 'oasis-mock-adapter';
