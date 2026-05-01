#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { REGIONS } from './shared/geography.js';
import { applySelfHostRedisRestDefaults, loadEnvFile } from './_seed-utils.mjs';
import { OASIS_SIM_MODE } from './oasis-sim/types.mjs';
import { readSourcesSafeForOasis, runOasisThreeAgentPipeline } from './oasis-sim/pipeline.mjs';

loadEnvFile(import.meta.url);
applySelfHostRedisRestDefaults();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const region = REGIONS.find((r) => r.id === args.regionId);
  if (!region) {
    throw new Error(`Unknown region "${args.regionId}". Try one of: ${REGIONS.map((r) => r.id).join(', ')}`);
  }

  const startedAt = Date.now();
  const warnings = [];

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    warnings.push('UPSTASH Redis env not set; using empty sources (orchestration trace still runs)');
  }

  const sources = await readSourcesSafeForOasis(warnings);
  const sourceKeysPresent = Object.entries(sources).filter(([, value]) => value !== null && value !== undefined).length;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && sourceKeysPresent === 0) {
    warnings.push('Redis configured but no source keys returned (pipeline empty or parse failure)');
  }

  const { events, trace, warnings: pipeWarnings } = await runOasisThreeAgentPipeline({
    regionId: args.regionId,
    horizon: args.horizon,
    dryRun: args.dryRun,
    startedAt,
    sources,
  });
  warnings.push(...pipeWarnings);

  const finishedAt = Date.now();
  const output = {
    runMeta: {
      mode: OASIS_SIM_MODE,
      regionId: args.regionId,
      horizon: args.horizon,
      dryRun: args.dryRun,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    },
    events,
    trace,
    warnings: [...new Set(warnings)],
  };

  if (args.outputFile) {
    await writeFile(args.outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }

  if (args.pretty) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(JSON.stringify(output));
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ regionId: string; horizon: '24h' | '7d' | '30d'; dryRun: boolean; pretty: boolean; help: boolean; outputFile: string }} */
  const args = {
    regionId: 'mena',
    horizon: '7d',
    dryRun: false,
    pretty: false,
    help: false,
    outputFile: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--region' && argv[i + 1]) args.regionId = argv[++i];
    else if (token === '--horizon' && argv[i + 1]) {
      const horizon = argv[++i];
      if (horizon === '24h' || horizon === '7d' || horizon === '30d') args.horizon = horizon;
      else throw new Error(`Invalid --horizon "${horizon}" (use 24h, 7d, or 30d)`);
    } else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--pretty') args.pretty = true;
    else if (token === '--output' && argv[i + 1]) args.outputFile = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${token}`);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/run-oasis-sim.mjs [options]',
      '',
      'Options:',
      '  --region <id>      region id (default: mena)',
      '  --horizon <h>      one of: 24h | 7d | 30d (default: 7d)',
      '  --dry-run          mark run as dry run in runMeta',
      '  --pretty           pretty-print JSON to stdout',
      '  --output <file>    write JSON to file',
      '  --help, -h         show help',
      '',
      'Example: npm run sim:oasis -- --region mena --horizon 7d --pretty',
      '',
      'Polymarket alignment (Phase B): npm run sim:oasis:polymarket-b',
    ].join('\n'),
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[oasis-sim] FAILED: ${err?.message ?? err}`);
    process.exit(1);
  });
}

export { main };
