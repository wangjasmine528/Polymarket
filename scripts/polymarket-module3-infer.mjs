#!/usr/bin/env node
// @ts-check
/**
 * 模块 3：单独用 Claude 拉一条概率（设计稿 JSON），再与固定分量融合。
 * 需 ANTHROPIC_API_KEY；不写入 Redis。
 *
 *   node scripts/polymarket-module3-infer.mjs --title "事件标题" --price 0.35 --side yes
 *   node scripts/polymarket-module3-infer.mjs --help
 */

import { pathToFileURL } from 'node:url';

import { createAnthropicCallLlm } from './_polymarket-anthropic.mjs';
import { loadEnvFile } from './_seed-utils.mjs';
import {
  buildProbabilityPrompt,
  parseLlmProbabilityJson,
  buildFusedProbabilityEstimateFromLlmParse,
} from './_polymarket-probability.mjs';
import { extractFirstJsonObject } from './_polymarket-multi-agent.mjs';

loadEnvFile(import.meta.url);

const MODULE3_SYSTEM = '你是预测市场分析师。只输出一段 JSON，不要 markdown 围栏以外的解释。';

function parseArgValue(name) {
  const idx = process.argv.findIndex((a) => a === name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function printHelp() {
  console.log(`polymarket-module3-infer — Claude 概率 + 融合 + edge

用法:
  node scripts/polymarket-module3-infer.mjs --title "..." --price 0.35 --side yes
  node scripts/polymarket-module3-infer.mjs --title "..." --price 0.35 --side no --end-date 2026-12-31

参数:
  --title <text>     事件标题（必填）
  --price <0-1>     当前腿市价概率（必填，可与模块1 currentPrice 一致）
  --side yes|no     模块1 cheaper-side（必填）
  --end-date <iso>  可选
  --help

环境: ANTHROPIC_API_KEY（必填）, ANTHROPIC_MODEL（可选）, ANTHROPIC_TIMEOUT_MS（可选，毫秒）
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const title = parseArgValue('--title');
  const price = parseArgValue('--price');
  const side = (parseArgValue('--side') || 'yes').toLowerCase();
  const endDate = parseArgValue('--end-date') || '';

  if (!title || price == null) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  if (side !== 'yes' && side !== 'no') {
    console.error('[module3-infer] --side must be yes or no');
    process.exitCode = 1;
    return;
  }

  const candidate = {
    title,
    currentPrice: Number(price),
    side,
    marketId: 'cli',
    source: 'polymarket',
    yesPrice: side === 'yes' ? Number(price) * 100 : (1 - Number(price)) * 100,
  };

  const callLlm = await createAnthropicCallLlm();
  const user = buildProbabilityPrompt({
    eventTitle: title,
    eventDescription: '',
    expiryDate: endDate,
    marketPrice: candidate.currentPrice,
    newsContext: '（CLI：无独立新闻管道，请依据标题与市价推理。）',
  });
  const text = await callLlm({ system: MODULE3_SYSTEM, user });
  const parsed = parseLlmProbabilityJson(extractFirstJsonObject(text));
  const fused = buildFusedProbabilityEstimateFromLlmParse(parsed, candidate, [candidate]);
  console.log(JSON.stringify({ llmRaw: parsed, fused }, null, 2));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[module3-infer] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
