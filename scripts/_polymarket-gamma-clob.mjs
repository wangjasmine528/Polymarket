/**
 * Gamma API：按 market id 取 CLOB token id（YES/NO）。
 */

import { CHROME_UA } from './_seed-utils.mjs';

const GAMMA_MARKET = 'https://gamma-api.polymarket.com/markets';

export async function fetchGammaMarketById(marketId) {
  const id = encodeURIComponent(String(marketId));
  const resp = await fetch(`${GAMMA_MARKET}/${id}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`Gamma markets/${id} HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * Gamma 常把 `clobTokenIds` 存成 JSON 字符串数组。
 * @returns {{ yesTokenId: string, noTokenId: string }}
 */
export function parseClobTokenIds(gammaMarket) {
  let raw = gammaMarket?.clobTokenIds ?? gammaMarket?.clob_token_ids;
  if (raw == null) throw new Error('Market missing clobTokenIds');
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('clobTokenIds is not valid JSON string');
    }
  }
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('clobTokenIds must be an array of at least 2 token ids');
  }
  return { yesTokenId: String(raw[0]), noTokenId: String(raw[1]) };
}

/**
 * @param {'yes'|'no'} outcome 要交易的腿（与模块1 side 语义一致）
 */
export function pickTokenIdForOutcome(gammaMarket, outcome) {
  const { yesTokenId, noTokenId } = parseClobTokenIds(gammaMarket);
  const o = String(outcome || 'yes').toLowerCase();
  if (o === 'no') return noTokenId;
  return yesTokenId;
}

/**
 * Gamma `outcomePrices` JSON 数组 [yes, no] 近似中间价（0~1）；失败返回 null。
 * @param {'yes'|'no'} outcome
 */
export function inferMidFromGammaOutcomePrices(gammaMarket, outcome) {
  try {
    const prices = JSON.parse(gammaMarket.outcomePrices || '[]');
    const idx = String(outcome).toLowerCase() === 'no' ? 1 : 0;
    const p = parseFloat(prices[idx]);
    if (Number.isFinite(p) && p > 0 && p < 1) return p;
  } catch {
    /* ignore */
  }
  return null;
}
