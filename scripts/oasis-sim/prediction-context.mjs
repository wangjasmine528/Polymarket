// @ts-check

import { REGIONS } from '../shared/geography.js';
import { FRESHNESS_REGISTRY } from '../regional-snapshot/freshness.mjs';
import { collectEvidence } from '../regional-snapshot/evidence-collector.mjs';

/**
 * @typedef {{
 *   version: string
 *   regionId: string
 *   horizon: string
 *   polymarket: {
 *     eventSlug: string
 *     marketSlug: string
 *     gammaEventUrl: string
 *     eventSubMarketCount: number
 *   }
 *   provenance: Array<{
 *     key: string
 *     origin: 'upstash-redis' | 'none'
 *     present: boolean
 *     feedsAxes: string[]
 *   }>
 *   propagationGraph: {
 *     nodes: Array<{ id: string; kind: string; label: string }>
 *     edges: Array<{ from: string; to: string; relation: string; note?: string }>
 *   }
 *   breadth: {
 *     redisKeysPresent: number
 *     redisKeysTotalTracked: number
 *     evidenceItemCount: number
 *     distinctEvidenceSources: number
 *     crossSourceSignalCount: number
 *     theatersTouched: string[]
 *   }
 * }} PredictionContext
 */

const CONTEXT_VERSION = 'd1-provenance-v1';

/**
 * @param {{
 *   regionId: string
 *   horizon: string
 *   sources: Record<string, any>
 *   polymarket: { eventSlug: string; marketSlug: string; eventSubMarketCount: number }
 * }} opts
 * @returns {PredictionContext}
 */
export function buildPredictionContext(opts) {
  const { regionId, horizon, sources, polymarket } = opts;
  const region = REGIONS.find((r) => r.id === regionId);

  const keyToAxes = new Map(FRESHNESS_REGISTRY.map((s) => [s.key, s.feedsAxes ?? []]));

  /** @type {PredictionContext['provenance']} */
  const provenance = [];
  let redisKeysPresent = 0;
  for (const spec of FRESHNESS_REGISTRY) {
    const v = sources[spec.key];
    const present = v !== null && v !== undefined;
    if (present) redisKeysPresent += 1;
    provenance.push({
      key: spec.key,
      origin: present ? 'upstash-redis' : 'none',
      present,
      feedsAxes: keyToAxes.get(spec.key) ?? [],
    });
  }

  const evidence = collectEvidence(regionId, sources);
  const distinctSources = new Set(evidence.map((e) => String(e.source ?? '')));
  const xss = sources['intelligence:cross-source-signals:v1']?.signals;
  const crossSourceSignalCount = Array.isArray(xss) ? xss.length : 0;

  const theatersTouched = region
    ? [...new Set([...region.theaters, ...(region.signalAliases ?? [])].map(String))]
    : [];

  const gammaUrl = `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(polymarket.eventSlug)}`;

  const nodes = [
    { id: 'pm:gamma', kind: 'external_api', label: 'Polymarket Gamma (event)' },
    { id: `region:${regionId}`, kind: 'worldmonitor_region', label: region?.label ?? regionId },
    { id: 'wm:oasis_pipeline', kind: 'oasis_mock', label: 'Hypothesis→Evidence→Adjudicator' },
    { id: 'bridge:market_yes', kind: 'calibration', label: 'Lane bundle → P(Yes)' },
  ];

  const edges = [
    { from: 'pm:gamma', to: `region:${regionId}`, relation: 'market_underlay', note: 'Binary market scoped to regional priors' },
    { from: `region:${regionId}`, to: 'wm:oasis_pipeline', relation: 'redis_and_rules', note: 'Regional snapshot inputs drive lanes' },
    { from: 'wm:oasis_pipeline', to: 'bridge:market_yes', relation: 'scenario_mass_to_probability' },
  ];

  for (const p of provenance.filter((x) => x.present).slice(0, 12)) {
    const nid = `redis:${p.key}`;
    nodes.push({ id: nid, kind: 'redis_key', label: p.key });
    edges.push({
      from: nid,
      to: 'wm:oasis_pipeline',
      relation: 'feeds_axes',
      note: (p.feedsAxes ?? []).slice(0, 3).join(','),
    });
  }

  return {
    version: CONTEXT_VERSION,
    regionId,
    horizon,
    polymarket: {
      eventSlug: polymarket.eventSlug,
      marketSlug: polymarket.marketSlug,
      gammaEventUrl: gammaUrl,
      eventSubMarketCount: polymarket.eventSubMarketCount,
    },
    provenance,
    propagationGraph: { nodes, edges },
    breadth: {
      redisKeysPresent,
      redisKeysTotalTracked: FRESHNESS_REGISTRY.length,
      evidenceItemCount: evidence.length,
      distinctEvidenceSources: distinctSources.size,
      crossSourceSignalCount,
      theatersTouched,
    },
  };
}
