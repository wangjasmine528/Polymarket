/**
 * CLOB 公开行情：midpoint（无需鉴权）。
 * 文档：https://docs.polymarket.com/api-reference/data/get-midpoint-price
 */

import { CHROME_UA } from './_seed-utils.mjs';

const DEFAULT_HOST = 'https://clob.polymarket.com';

/**
 * @param {string} tokenId
 * @param {{ host?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<number|null>} 0~1 概率价，失败返回 null
 */
export async function fetchClobMidpoint(tokenId, opts = {}) {
  const host = opts.host || process.env.POLYMARKET_CLOB_HOST || DEFAULT_HOST;
  const id = encodeURIComponent(String(tokenId));
  const timeoutMs = Number(opts.timeoutMs ?? 15_000);
  const url = `${host}/midpoint?token_id=${id}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const raw = data?.mid ?? data?.mid_price ?? data?.price;
  const p = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return p;
}

/**
 * @param {string[]} tokenIds
 * @param {{ host?: string, timeoutMs?: number, chunkSize?: number }} [opts]
 * @returns {Promise<Record<string, number|null>>}
 */
export async function fetchClobMidpoints(tokenIds, opts = {}) {
  const host = opts.host || process.env.POLYMARKET_CLOB_HOST || DEFAULT_HOST;
  const timeoutMs = Number(opts.timeoutMs ?? 15_000);
  const chunkSize = Math.max(1, Math.min(Number(opts.chunkSize ?? 40), 80));
  const unique = [...new Set((tokenIds || []).map(String).filter(Boolean))];
  /** @type {Record<string, number|null>} */
  const out = {};
  for (let i = 0; i < unique.length; i += chunkSize) {
    const slice = unique.slice(i, i + chunkSize);
    const qs = slice.map((t) => encodeURIComponent(t)).join(',');
    const url = `${host}/midpoints?token_ids=${qs}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      for (const t of slice) out[t] = null;
      continue;
    }
    const data = await resp.json().catch(() => null);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const t of slice) {
        const raw = data[t];
        const p = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
        out[t] = Number.isFinite(p) && p > 0 && p < 1 ? p : null;
      }
    } else {
      for (const t of slice) out[t] = null;
    }
  }
  return out;
}
