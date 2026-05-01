#!/usr/bin/env node
// @ts-check
/**
 * 连续调用 Gamma 快照采样，直到 jsonl 达到目标行数（默认 120）。
 * 复用 `runPolymarketUsIranPeaceSnapshot()`，与单次脚本写入同一文件规则一致。
 *
 * Usage:
 *   node scripts/polymarket-us-iran-peace-snapshot-burst.mjs
 *   node scripts/polymarket-us-iran-peace-snapshot-burst.mjs --target 120 --delay-ms 500
 *
 * Env:
 *   POLYMARKET_SAMPLE_OUTPUT   输出 jsonl 路径（与 snapshot 脚本一致）
 *   BURST_TARGET_LINES         目标行数（默认 120）
 *   BURST_DELAY_MS             每次成功采样后的间隔毫秒（默认 400）
 *   BURST_MAX_ATTEMPTS         最大尝试次数含失败重试（默认 500）
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPolymarketUsIranPeaceSnapshot } from './polymarket-us-iran-peace-snapshot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgValue(name) {
  const idx = process.argv.findIndex((arg) => arg === name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function countJsonlLines(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split('\n').map((l) => l.trim()).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main() {
  const outPath =
    process.env.POLYMARKET_SAMPLE_OUTPUT?.trim() ||
    join(__dirname, '..', 'data', 'polymarket', 'us-iran-peace-deal-timeseries.jsonl');

  const targetRaw = Number(process.env.BURST_TARGET_LINES || parseArgValue('--target') || 120);
  const delayMsRaw = Number(process.env.BURST_DELAY_MS || parseArgValue('--delay-ms') || 400);
  const maxAttemptsRaw = Number(process.env.BURST_MAX_ATTEMPTS || parseArgValue('--max-attempts') || 500);

  const target = Number.isFinite(targetRaw) && targetRaw > 0 ? targetRaw : 120;
  const delayMs = Number.isFinite(delayMsRaw) && delayMsRaw >= 0 ? delayMsRaw : 400;
  const maxAttempts = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? maxAttemptsRaw : 500;

  let lines = await countJsonlLines(outPath);
  console.log(`[polymarket-burst] file=${outPath} currentLines=${lines} target=${target} delayMs=${delayMs}`);

  if (lines >= target) {
    console.log('[polymarket-burst] already at or above target — nothing to do');
    return;
  }

  let attempts = 0;
  while (lines < target && attempts < maxAttempts) {
    attempts += 1;
    try {
      await runPolymarketUsIranPeaceSnapshot();
      lines += 1;
      console.log(`[polymarket-burst] ok ${lines}/${target} (attempt ${attempts})`);
      if (lines < target && delayMs > 0) await sleep(delayMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[polymarket-burst] attempt ${attempts} failed: ${msg} — retry in 2s`);
      await sleep(2000);
    }
  }

  const finalLines = await countJsonlLines(outPath);
  if (finalLines < target) {
    console.error(`[polymarket-burst] stopped at ${finalLines}/${target} after ${attempts} attempts (see errors above)`);
    process.exit(1);
  }
  console.log(`[polymarket-burst] done lines=${finalLines}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[polymarket-burst] FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
