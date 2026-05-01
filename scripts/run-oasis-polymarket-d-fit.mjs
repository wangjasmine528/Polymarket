#!/usr/bin/env node
// @ts-check
/**
 * Phase D — Fit ridge regression from scenario lane probabilities → Polymarket pMarketYes
 * using historical Phase B alignment rows. Writes data/polymarket/oasis-d-calibration-weights.json
 *
 *   npm run sim:oasis:polymarket-d-fit -- --pretty
 *   npm run sim:oasis:polymarket-d-fit -- --alignment ./data/polymarket/us-iran-oasis-b-alignment.jsonl
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { ridgeFitWithIntercept } from './oasis-sim/ridge-fit.mjs';
import { DEFAULT_CALIBRATION_PATH } from './oasis-sim/calibrated-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALIGNMENT = join(__dirname, '..', 'data', 'polymarket', 'us-iran-oasis-b-alignment.jsonl');

/** Re-read file with full rows for fit (loadAlignmentPoints already parses). */
async function loadRowsForFit(alignmentPath) {
  /** @type {Array<{ p: number; b: number; e: number; c: number; f: number }>} */
  const rows = [];
  const rl = createInterface({ input: createReadStream(alignmentPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      /** @type {any} */
      const row = JSON.parse(trimmed);
      if (row.kind !== 'oasis_b_polymarket_alignment') continue;
      const y = Number(row?.polymarket?.pMarketYes);
      const lp = row?.oasis?.laneProbabilities;
      if (!Number.isFinite(y) || !lp || typeof lp !== 'object') continue;
      const b = Number(lp.base);
      const e = Number(lp.escalation);
      const c = Number(lp.containment);
      const f = Number(lp.fragmentation);
      if (![b, e, c, f].every(Number.isFinite)) continue;
      rows.push({ p: y, b, e, c, f });
    } catch {
      /* skip */
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const alignmentPath = args.alignmentPath || DEFAULT_ALIGNMENT;
  const rows = await loadRowsForFit(alignmentPath);
  const lambda = args.ridgeLambda;

  if (rows.length >= 2) {
    const [a] = rows;
    const allSameLanes = rows.every((r) => r.b === a.b && r.e === a.e && r.c === a.c && r.f === a.f);
    if (allSameLanes) {
      console.warn(
        '[oasis-d-fit] all training rows share the same lane vector (e.g. empty Redis). Intercept will match mean pMarket; slopes stay ~0. Add diverse regional inputs for real calibration.',
      );
    }
  }

  if (rows.length < 3) {
    console.error(
      `[oasis-d-fit] need at least 3 alignment rows with laneProbabilities + pMarketYes (got ${rows.length}). Run sim:oasis:polymarket-b a few times.`,
    );
    process.exit(1);
  }

  /** @type {number[][]} */
  const X = rows.map((r) => [1, r.b, r.e, r.c, r.f]);
  const y = rows.map((r) => r.p);
  const { coef, trainMse } = ridgeFitWithIntercept(X, y, lambda);

  const weights = {
    base: coef[1],
    escalation: coef[2],
    containment: coef[3],
    fragmentation: coef[4],
  };

  const out = {
    version: 'd-ridge-lanes-v1',
    intercept: round(coef[0]),
    weights: {
      base: round(weights.base),
      escalation: round(weights.escalation),
      containment: round(weights.containment),
      fragmentation: round(weights.fragmentation),
    },
    ridgeLambda: lambda,
    fittedAt: new Date().toISOString(),
    nTrain: rows.length,
    trainMse: round(trainMse),
    alignmentPath,
  };

  await mkdir(dirname(DEFAULT_CALIBRATION_PATH), { recursive: true });
  await writeFile(DEFAULT_CALIBRATION_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  if (args.pretty) {
    console.log(JSON.stringify({ savedTo: DEFAULT_CALIBRATION_PATH, fit: out }, null, 2));
    return;
  }
  console.log(JSON.stringify({ savedTo: DEFAULT_CALIBRATION_PATH, fit: out }));
}

function round(x) {
  return Math.round(x * 100000) / 100000;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ alignmentPath: string; ridgeLambda: number; pretty: boolean; help: boolean }} */
  const args = {
    alignmentPath: '',
    ridgeLambda: 0.05,
    pretty: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--alignment' && argv[i + 1]) args.alignmentPath = argv[++i];
    else if (t === '--ridge' && argv[i + 1]) args.ridgeLambda = Math.max(1e-6, Number(argv[++i]) || 0.05);
    else if (t === '--pretty') args.pretty = true;
    else if (t === '--help' || t === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${t}`);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/run-oasis-polymarket-d-fit.mjs [options]',
      '',
      'Fits ridge regression pMarket ~ intercept + w·lanes from Phase B JSONL.',
      'Writes: data/polymarket/oasis-d-calibration-weights.json',
      '',
      'Options:',
      '  --alignment <path>',
      '  --ridge <lambda>   default 0.05 (slopes only; intercept not penalized)',
      '  --pretty',
      '  --help',
    ].join('\n'),
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[oasis-d-fit] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

export { main };
