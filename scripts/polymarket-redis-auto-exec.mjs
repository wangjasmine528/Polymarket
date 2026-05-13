#!/usr/bin/env node
// @ts-check
/**
 * 闭环：读 Redis `prediction:markets-bootstrap:v1` → 按模块4 judge 筛 Polymarket 候选
 * → Gamma 取 token → 模块5 限价 GTC（默认 dry-run）。
 *
 * 幂等：`polymarket:auto-exec:done:v1:<marketId>:<outcome>` 存在则跳过；
 * 提交前 `polymarket:auto-exec:lock:v1:<marketId>:<outcome>` SET NX（防并发双发）。
 *
 *   node scripts/polymarket-redis-auto-exec.mjs
 *   node scripts/polymarket-redis-auto-exec.mjs --execute
 *
 * 需 UPSTASH_REDIS_REST_*；--execute 另需 POLYMARKET_PRIVATE_KEY 等（同 polymarket-execute-order）。
 */

import { pathToFileURL } from 'node:url';

import {
  loadEnvFile,
  applySelfHostRedisRestDefaults,
  readSeedSnapshot,
  redisGetStringKey,
  redisSetNxEx,
  redisDelKey,
  redisCall,
} from './_seed-utils.mjs';
import {
  candidatePassesAutoExecFilters,
  PREDICTION_MARKETS_BOOTSTRAP_KEY,
  sharesFromPositionUsd,
} from './_polymarket-loop-helpers.mjs';
import { buildUserOrderFromDecision } from './_polymarket-execution.mjs';
import {
  fetchGammaMarketById,
  pickTokenIdForOutcome,
  inferMidFromGammaOutcomePrices,
} from './_polymarket-gamma-clob.mjs';
import { createPolymarketClobTradingClient, createAndPostGtcLimitOrder } from './_polymarket-clob-trading.mjs';
import {
  appendOpenPosition,
  resolveLedgerPath,
  daysToExpiryFromEndDate,
} from './_polymarket-positions-ledger.mjs';

loadEnvFile(import.meta.url);

function parseArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function parseActions(s) {
  if (!s || s === '*') return ['buy', 'short'];
  return String(s)
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x === 'buy' || x === 'short');
}

function printHelp() {
  console.log(`polymarket-redis-auto-exec — Redis 候选 → 模块4 → 模块5（默认 dry-run）

用法:
  node scripts/polymarket-redis-auto-exec.mjs
  node scripts/polymarket-redis-auto-exec.mjs --execute

常用参数:
  --redis-key <key>     默认 ${PREDICTION_MARKETS_BOOTSTRAP_KEY}
  --max-scan <n>       扫描前 N 条 candidate（默认 80）
  --actions buy,short  judge 动作白名单（默认 buy,short）
  --require-smart-money
  --min-position-usd <n>   默认 1
  --max-position-usd <n>   份额估算时 cap（可选，也可用环境变量 POLYMARKET_AUTO_MAX_USD）
  --min-judge-edge <n>     可选，裁判 edge 下限
  --min-shares / --max-shares / --slippage  同执行层语义
  --dedupe-ttl-sec <n>     成功标记 TTL（默认 86400）
  --lock-ttl-sec <n>       并发锁 TTL（默认 180）

环境:
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
  POLYMARKET_AUTO_MAX_USD（与 --max-position-usd 二选一）
  POLYMARKET_LEDGER_APPEND  设为 0 或 false 时，--execute 成功后不写持仓账本（默认写）
  POLYMARKET_POSITIONS_LEDGER_PATH  账本 JSON 路径（默认 data/polymarket/open-positions.json）
`);
}

function numArg(name, def) {
  const v = parseArgValue(name);
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** @returns {Promise<{ candidate: object, pass: object, lockKey: string, doneKey: string } | null>} */
async function pickFirstRunnable(candidates, filterOpts, { maxScan, dedupeKeyPrefix, lockTtlSec }) {
  const n = Math.min(candidates.length, maxScan);
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const pass = candidatePassesAutoExecFilters(c, filterOpts);
    if (!pass.ok || !pass.trade) continue;
    const mid = String(c.marketId || '');
    if (!mid) continue;
    const outcome = pass.trade.outcome;
    const doneKey = `${dedupeKeyPrefix}:done:v1:${mid}:${outcome}`;
    const lockKey = `${dedupeKeyPrefix}:lock:v1:${mid}:${outcome}`;

    const prior = await redisGetStringKey(doneKey);
    if (prior) continue;

    const locked = await redisSetNxEx(lockKey, String(Date.now()), lockTtlSec);
    if (!locked) continue;

    return { candidate: c, pass, lockKey, doneKey };
  }
  return null;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  applySelfHostRedisRestDefaults();

  const redisKey = parseArgValue('--redis-key') || PREDICTION_MARKETS_BOOTSTRAP_KEY;
  const doExecute = process.argv.includes('--execute');
  const maxScan = Math.max(1, numArg('--max-scan', Number(process.env.POLYMARKET_AUTO_MAX_SCAN ?? 80)));
  const actions = parseActions(parseArgValue('--actions') || process.env.POLYMARKET_AUTO_ACTIONS || 'buy,short');
  const requireSmartMoney = process.argv.includes('--require-smart-money');
  const minPositionUsd = numArg('--min-position-usd', Number(process.env.POLYMARKET_AUTO_MIN_USD ?? 1));
  const maxPositionUsd =
    parseArgValue('--max-position-usd') != null
      ? numArg('--max-position-usd', NaN)
      : Number(process.env.POLYMARKET_AUTO_MAX_USD ?? NaN);
  const minJudgeEdge = numArg('--min-judge-edge', Number(process.env.POLYMARKET_AUTO_MIN_JUDGE_EDGE ?? NaN));
  const minShares = Math.max(1, numArg('--min-shares', Number(process.env.POLYMARKET_AUTO_MIN_SHARES ?? 1)));
  const maxShares = Math.max(1, numArg('--max-shares', Number(process.env.POLYMARKET_AUTO_MAX_SHARES ?? 25)));
  const slippage = parseArgValue('--slippage') == null ? 0.005 : Number(parseArgValue('--slippage'));
  const dedupeTtlSec = Math.max(60, numArg('--dedupe-ttl-sec', Number(process.env.POLYMARKET_AUTO_DEDUPE_TTL_SEC ?? 86_400)));
  const lockTtlSec = Math.max(30, numArg('--lock-ttl-sec', Number(process.env.POLYMARKET_AUTO_LOCK_TTL_SEC ?? 180)));
  const dedupeKeyPrefix = String(process.env.POLYMARKET_AUTO_DEDUPE_PREFIX || 'polymarket:auto-exec');

  const filterOpts = {
    actions,
    requireSmartMoney,
    minPositionUsd,
    maxPositionUsd: Number.isFinite(maxPositionUsd) && maxPositionUsd > 0 ? maxPositionUsd : undefined,
    minJudgeEdge: Number.isFinite(minJudgeEdge) && minJudgeEdge > 0 ? minJudgeEdge : undefined,
  };

  const snap = await readSeedSnapshot(redisKey);
  if (!snap || !Array.isArray(snap.candidates)) {
    console.error(`[auto-exec] no snapshot or candidates at key=${redisKey}`);
    process.exitCode = 1;
    return;
  }

  const picked = await pickFirstRunnable(snap.candidates, filterOpts, { maxScan, dedupeKeyPrefix, lockTtlSec });
  if (!picked) {
    console.log('[auto-exec] no eligible candidate (filters, dedupe, or lock).');
    return;
  }

  const { candidate: c, pass, lockKey, doneKey } = picked;
  const marketId = String(c.marketId);
  const { outcome, refMarketPrice01 } = pass.trade;
  const positionUsd = /** @type {number} */ (pass.positionUsdForSizing);

  let gamma;
  try {
    gamma = await fetchGammaMarketById(marketId);
  } catch (err) {
    await redisDelKey(lockKey);
    console.error(`[auto-exec] Gamma fetch failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  const tokenId = pickTokenIdForOutcome(gamma, outcome);
  const midGamma = inferMidFromGammaOutcomePrices(gamma, outcome);
  const marketPrice = midGamma ?? refMarketPrice01;

  const size = sharesFromPositionUsd(positionUsd, marketPrice, { minShares, maxShares });
  if (size <= 0) {
    await redisDelKey(lockKey);
    console.error('[auto-exec] computed size=0 (raise cap or min-position-usd)');
    process.exitCode = 1;
    return;
  }

  const built = buildUserOrderFromDecision({
    action: pass.judgeAction,
    token_id: tokenId,
    market_price: marketPrice,
    clobSide: 'BUY',
    position_size: size,
    slippage_tolerance: slippage,
  });

  if (built.skip) {
    await redisDelKey(lockKey);
    console.error(`[auto-exec] build order skip: ${built.reason}`);
    process.exitCode = 1;
    return;
  }

  const plan = {
    dryRun: !doExecute,
    redisKey,
    marketId,
    title: c.title,
    judge: c.agentValidation?.judge,
    outcome,
    positionUsdForSizing: positionUsd,
    tokenID: built.userOrder.tokenID,
    side: built.userOrder.side,
    price: built.userOrder.price,
    size: built.userOrder.size,
    doneKey,
  };

  if (!doExecute) {
    await redisDelKey(lockKey);
    console.log('[auto-exec] DRY-RUN（未下单、已释放 lock）。加 --execute 提交 CLOB。');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  try {
    const { client, address } = await createPolymarketClobTradingClient();
    console.log(`[auto-exec] execute signer=${address}`);
    const res = await createAndPostGtcLimitOrder(client, built.userOrder);
    const payload = JSON.stringify({
      ts: Date.now(),
      marketId,
      outcome,
      response: res,
      plan: { ...plan, doneKey: undefined },
    });
    await redisCall(['SET', doneKey, payload, 'EX', String(dedupeTtlSec)]);
    console.log('[auto-exec] submitted');
    console.log(JSON.stringify({ plan, response: res }, null, 2));

    const ledgerOff =
      process.env.POLYMARKET_LEDGER_APPEND === '0' || process.env.POLYMARKET_LEDGER_APPEND === 'false';
    if (!ledgerOff) {
      try {
        const ledgerPath = resolveLedgerPath();
        const dte = daysToExpiryFromEndDate(c.endDate);
        await appendOpenPosition(ledgerPath, {
          tokenId,
          entryPrice01: marketPrice,
          peakPrice01: marketPrice,
          shares: built.userOrder.size,
          marketId,
          outcome,
          title: c.title,
          openedAtMs: Date.now(),
          daysToExpiry: dte == null || !Number.isFinite(dte) ? null : dte,
          source: 'polymarket-redis-auto-exec',
          orderSummary: { dryRun: false },
        });
        console.log(`[auto-exec] ledger: appended open position → ${ledgerPath}`);
      } catch (e) {
        console.warn(`[auto-exec] ledger append failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (err) {
    console.error(`[auto-exec] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await redisDelKey(lockKey);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[auto-exec] FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
