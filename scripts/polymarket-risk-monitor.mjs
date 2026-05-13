#!/usr/bin/env node
// @ts-check
/**
 * 模块 6：风险控制副线 — 读持仓 JSON，拉 CLOB midpoint，输出平仓建议（默认不下单）。
 *
 *   node scripts/polymarket-risk-monitor.mjs --input path/to/positions.json
 *   node scripts/polymarket-risk-monitor.mjs --input path/to/positions.json --watch --interval-ms 30000
 *
 * 持仓 JSON 示例见 docs/reports/polymarket-module6-risk-report.md
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadEnvFile } from './_seed-utils.mjs';
import { fetchClobMidpoints } from './_polymarket-clob-price.mjs';
import { DEFAULT_RISK_RULES, monitorPositions } from './_polymarket-risk-manager.mjs';
import { normalizePositionsForRisk } from './_polymarket-positions-ledger.mjs';

loadEnvFile(import.meta.url);

function parseArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function printHelp() {
  console.log(`polymarket-risk-monitor — 模块6 持仓风控扫描

用法:
  node scripts/polymarket-risk-monitor.mjs --input ./positions.json
  node scripts/polymarket-risk-monitor.mjs --input ./positions.json --watch --interval-ms 30000

参数:
  --input <path>        持仓 JSON 数组（必填）
  --rules-json <path>   可选，覆盖 DEFAULT_RISK_RULES 的 JSON 文件
  --watch               循环执行（默认只跑一轮）
  --interval-ms <n>     watch 间隔，默认 30000
  --no-fetch            不请求 CLOB；每条持仓需带 currentPrice01 字段作为现价
  --help

说明: 本脚本只输出建议，不调用撤单/卖单 API；与执行层解耦。
`);
}

function numArg(name, def) {
  const v = parseArgValue(name);
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function loadJsonPath(p) {
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw);
}

async function runOnce(positions, rules, noFetch) {
  const list = Array.isArray(positions) ? positions : [];
  const normalized = normalizePositionsForRisk(list);
  /** @type {Record<string, number|null>} */
  let priceByTokenId = {};
  if (noFetch) {
    for (const p of normalized) {
      const tid = String(p?.tokenId || '');
      const c = list.find((x) => String(x?.tokenId) === tid)?.currentPrice01;
      priceByTokenId[tid] = c == null ? null : Number(c);
    }
  } else {
    const ids = normalized.map((p) => String(p?.tokenId || '')).filter(Boolean);
    priceByTokenId = await fetchClobMidpoints(ids);
  }
  const results = monitorPositions(normalized, priceByTokenId, rules);
  const suggestedPeaks = {};
  for (const p of normalized) {
    const tid = String(p?.tokenId || '');
    const mid = priceByTokenId[tid];
    if (!tid || mid == null || !Number.isFinite(Number(mid))) continue;
    const peak = Math.max(Number(p?.peakPrice01 ?? p?.entryPrice01 ?? 0), Number(mid));
    if (Number.isFinite(peak)) suggestedPeaks[tid] = +peak.toFixed(6);
  }
  return { ts: Date.now(), results, midByToken: priceByTokenId, suggestedPeakPrice01: suggestedPeaks };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const inputPath = parseArgValue('--input');
  if (!inputPath) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const watch = process.argv.includes('--watch');
  const intervalMs = Math.max(5_000, numArg('--interval-ms', 30_000));
  const noFetch = process.argv.includes('--no-fetch');

  let rules = { ...DEFAULT_RISK_RULES };
  const rulesPath = parseArgValue('--rules-json');
  if (rulesPath) {
    const extra = await loadJsonPath(rulesPath);
    rules = { ...DEFAULT_RISK_RULES, ...extra };
  }

  const run = async () => {
    const positions = await loadJsonPath(inputPath);
    const out = await runOnce(positions, rules, noFetch);
    console.log(JSON.stringify(out, null, 2));
  };

  await run();
  if (!watch) return;

  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await run();
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[risk-monitor] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
