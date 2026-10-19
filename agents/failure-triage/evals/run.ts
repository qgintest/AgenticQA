#!/usr/bin/env node
import path from 'node:path';
import { planFor, runEval } from './runner';
import { loadScenarios } from './scenario';

/**
 * Usage: npm run eval -- [--yes] [--dry-run] [--repeat N] [--scenario a,b] [--out dir]
 *                        [--concurrency N] [--min-accuracy 0.8] [--price-in X --price-out Y]
 *
 * Runs the real triage agent (src/triage.ts) over every scenario in evals/scenarios N times and
 * writes <out>/results.json and <out>/summary.md. A real run calls the Claude API and costs money:
 * it prints the worst case first and only proceeds with --yes. --dry-run uses a scripted fake model
 * (no key, no cost) that answers with the deterministic heuristics.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS = path.join(PACKAGE_ROOT, 'evals', 'scenarios');

interface Args {
  yes: boolean;
  dryRun: boolean;
  repeat: number;
  scenarios: string[];
  out: string;
  concurrency: number;
  minAccuracy: number | null;
  priceIn?: number;
  priceOut?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { yes: false, dryRun: false, repeat: 3, scenarios: [], out: path.join(PACKAGE_ROOT, 'evals', 'out'), concurrency: 1, minAccuracy: null };
  const number = (flag: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < min || n > max) throw new Error(`${flag} needs a number between ${min} and ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    switch (flag) {
      case '--yes':
        args.yes = true;
        continue;
      case '--dry-run':
        args.dryRun = true;
        continue;
      case '--repeat':
        args.repeat = Math.floor(number(flag, value, 1, 20));
        break;
      case '--scenario':
        if (!value) throw new Error('--scenario needs a comma-separated list of names');
        args.scenarios = value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--out':
        if (!value) throw new Error('--out needs a directory');
        args.out = path.resolve(value);
        break;
      case '--concurrency':
        args.concurrency = Math.floor(number(flag, value, 1, 4));
        break;
      case '--min-accuracy':
        args.minAccuracy = number(flag, value, 0, 1);
        break;
      case '--price-in':
        args.priceIn = number(flag, value, 0, 1000);
        break;
      case '--price-out':
        args.priceOut = number(flag, value, 0, 1000);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
    i++;
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = loadScenarios(SCENARIOS, args.scenarios);
  const priceOverride = args.priceIn !== undefined || args.priceOut !== undefined ? { input: args.priceIn, output: args.priceOut } : undefined;
  const { plan, model, effort } = planFor({ scenarios, repeat: args.repeat, env: process.env, dryRun: args.dryRun, priceOverride });

  console.log(`eval: ${scenarios.length} scenario(s) × ${args.repeat} run(s) = ${plan.runs} triage runs: ${scenarios.map((s) => s.name).join(', ')}`);
  if (args.dryRun) {
    console.log('eval: dry run with the scripted fake model (no API calls, no cost)');
  } else {
    console.log(`eval: model ${model} (effort ${effort})`);
    console.log(`eval: at most ${plan.maxModelCalls} model calls; cost ceiling $${plan.ceilingUsd.toFixed(2)} ($${plan.ceilingPerRunUsd.toFixed(2)} per run at the configured TRIAGE_* limits)`);
    console.log('eval: typical runs use a small fraction of the ceiling; a refusal fallback to another model is not included');
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      console.error('eval: ANTHROPIC_API_KEY is not set. The eval runs the real agent against the Claude API; set the key, or use --dry-run to check the pipeline with the scripted fake model.');
      return 2;
    }
    if (!args.yes) {
      console.error(`eval: not started. Re-run with --yes to approve spending up to $${plan.ceilingUsd.toFixed(2)}.`);
      return 2;
    }
  }

  const result = await runEval({
    scenarios,
    repeat: args.repeat,
    outDir: args.out,
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    env: process.env,
    priceOverride,
    log: (l) => console.log(l),
  });
  const o = result.summary.overall;
  console.log(
    `eval: accuracy ${(o.accuracy.rate! * 100).toFixed(0)}% (${o.accuracy.hits}/${o.accuracy.n}), ` +
      `cost $${result.summary.costUsd.toFixed(3)}, results in ${path.relative(process.cwd(), args.out) || '.'}${path.sep}results.json and summary.md`,
  );
  if (result.aborted) return 1;
  if (args.minAccuracy !== null && (o.accuracy.rate ?? 0) < args.minAccuracy) {
    console.error(`eval: accuracy below --min-accuracy ${args.minAccuracy}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`eval: ${(e as Error)?.message ?? e}`);
    process.exit(2);
  },
);
