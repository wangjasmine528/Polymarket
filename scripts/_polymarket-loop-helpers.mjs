/**
 * Redis → 模块4 裁判 → 模块5 下单 闭环用的纯函数（无 I/O）。
 */

export const PREDICTION_MARKETS_BOOTSTRAP_KEY = 'prediction:markets-bootstrap:v1';

/**
 * @param {object} c candidate（含 side / currentPrice / yesPrice / noPrice）
 * @param {'buy'|'short'} judgeAction
 * @returns {{ outcome: 'yes'|'no', refMarketPrice01: number } | null}
 */
export function outcomeAndRefPriceForJudge(c, judgeAction) {
  const action = String(judgeAction || '').toLowerCase();
  if (action !== 'buy' && action !== 'short') return null;
  const side = String(c?.side || '').toLowerCase();
  if (side !== 'yes' && side !== 'no') return null;
  const cur = Number(c?.currentPrice);
  if (!Number.isFinite(cur) || cur <= 0 || cur >= 1) return null;

  if (action === 'buy') {
    return { outcome: /** @type {'yes'|'no'} */ (side), refMarketPrice01: cur };
  }
  // short：买入对侧 outcome token
  const opp = side === 'yes' ? 'no' : 'yes';
  let ref = NaN;
  if (opp === 'no' && c.noPrice != null) ref = Number(c.noPrice) / 100;
  else if (opp === 'yes' && c.yesPrice != null) ref = Number(c.yesPrice) / 100;
  else ref = 1 - cur;
  if (!Number.isFinite(ref) || ref <= 0 || ref >= 1) return null;
  return { outcome: /** @type {'yes'|'no'} */ (opp), refMarketPrice01: ref };
}

/**
 * @param {object} opts
 * @param {string[]} [opts.actions] 允许的 judge.action，默认 ['buy','short']
 * @param {boolean} [opts.requireSmartMoney]
 * @param {number} [opts.minPositionUsd]
 * @param {number} [opts.maxPositionUsd] 名义上限：用于份额估算时 cap（不拒绝更大 judge 建议）
 */
export function candidatePassesAutoExecFilters(c, opts = {}) {
  const actions = opts.actions ?? ['buy', 'short'];
  if (String(c?.source || '') !== 'polymarket') return { ok: false, reason: 'not_polymarket' };
  const judge = c?.agentValidation?.judge;
  const action = String(judge?.action || 'skip').toLowerCase();
  if (!actions.includes(action)) return { ok: false, reason: `judge_action_${action}` };
  const pos = Number(judge?.positionUsd);
  const minP = Number(opts.minPositionUsd ?? 1);
  if (!Number.isFinite(pos) || pos < minP) return { ok: false, reason: 'position_usd_too_small' };
  if (opts.requireSmartMoney && c?.smartMoney?.triggered !== true) {
    return { ok: false, reason: 'smart_money_not_triggered' };
  }
  const maxP = Number(opts.maxPositionUsd);
  let positionUsdForSizing = pos;
  if (Number.isFinite(maxP) && maxP > 0) positionUsdForSizing = Math.min(positionUsdForSizing, maxP);
  const edge = judge?.edge;
  const minEdge = Number(opts.minJudgeEdge);
  if (Number.isFinite(minEdge) && minEdge > 0) {
    const e = typeof edge === 'number' ? edge : Number(edge);
    if (!Number.isFinite(e) || e < minEdge) return { ok: false, reason: 'judge_edge_below_min' };
  }
  const trade = outcomeAndRefPriceForJudge(c, /** @type {'buy'|'short'} */ (action));
  if (!trade) return { ok: false, reason: 'cannot_resolve_outcome_price' };
  if (!Number.isFinite(positionUsdForSizing) || positionUsdForSizing < minP) {
    return { ok: false, reason: 'sized_usd_too_small_after_cap' };
  }
  return {
    ok: true,
    reason: '',
    judgeAction: /** @type {'buy'|'short'} */ (action),
    trade,
    positionUsdForSizing,
  };
}

/**
 * 用美元名义 / 参考概率价估算份额（保守 floor；与限价成本同量级）。
 */
export function sharesFromPositionUsd(positionUsd, refMarketPrice01, { minShares = 1, maxShares = 100 } = {}) {
  const usd = Number(positionUsd);
  const p = Number(refMarketPrice01);
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(p) || p <= 0) return 0;
  const raw = Math.floor(usd / p);
  if (!Number.isFinite(raw) || raw < minShares) return 0;
  return Math.min(raw, maxShares);
}

/**
 * @param {object[]} candidates
 * @param {object} opts 同 candidatePassesAutoExecFilters
 * @returns {{ candidate: object, judgeAction: 'buy'|'short', trade: { outcome: 'yes'|'no', refMarketPrice01: number }, positionUsdForSizing: number } | null}
 */
export function pickFirstAutoExecCandidate(candidates, opts = {}) {
  if (!Array.isArray(candidates)) return null;
  const maxScan = Math.max(1, Number(opts.maxScan ?? 100));
  for (let i = 0; i < Math.min(candidates.length, maxScan); i++) {
    const c = candidates[i];
    const pass = candidatePassesAutoExecFilters(c, opts);
    if (pass.ok && pass.trade && pass.judgeAction && typeof pass.positionUsdForSizing === 'number') {
      return {
        candidate: c,
        judgeAction: pass.judgeAction,
        trade: pass.trade,
        positionUsdForSizing: pass.positionUsdForSizing,
      };
    }
  }
  return null;
}
