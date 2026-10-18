#!/usr/bin/env node
// Banc d'essai de l'équipe d'agents : lance /team sur un petit projet d'essai et
// vérifie le résultat (état du run, Git, fichiers, coût). Voir bench/README.md.
//
// Usage :
//   node bench/run.mjs list
//   node bench/run.mjs prepare <scénario> [--dir <dossier>]
//   node bench/run.mjs run <scénario|all> --yes [--budget-usd 3] [--max-turns 300] [--dir <dossier>]
//   node bench/run.mjs verify <scénario> <dossier>
//
// `run` appelle la vraie API (coût réel) : il exige --yes ou BENCH_ALLOW_API=1.
// `list`, `prepare` et `verify` n'appellent jamais claude.
// Sortie : 0 tout réussi, 1 au moins une attente non tenue, 2 usage ou erreur.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLAUDE_RESULT, collectRun, evaluate } from './lib/assert.mjs';
import { childEnv, claudeArgs, runClaude } from './lib/claude.mjs';
import { listScenarios, loadScenario, prepare } from './lib/prepare.mjs';

const USAGE = `Usage :
  node bench/run.mjs list
  node bench/run.mjs prepare <scénario> [--dir <dossier>]
  node bench/run.mjs run <scénario|all> --yes [--budget-usd 3] [--max-turns 300] [--dir <dossier>]
  node bench/run.mjs verify <scénario> <dossier>`;

const VALUE_FLAGS = ['--dir', '--budget-usd', '--max-turns'];

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.includes(a)) {
      if (i + 1 >= args.length) throw new Error(`${a} attend une valeur`);
      flags[a] = args[++i];
    } else if (a === '--yes') flags.yes = true;
    else if (a.startsWith('--')) throw new Error(`option inconnue : ${a}`);
    else positional.push(a);
  }
  return { positional, flags };
}

function positiveNumber(value, flag, integer = false) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${flag} : nombre ${integer ? 'entier ' : ''}strictement positif attendu (reçu « ${value} »)`);
  }
  return n;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Rapport lisible d'un scénario. */
function report(log, name, run, result, wallMs) {
  const claude = run.claude ?? {};
  const cost = typeof claude.total_cost_usd === 'number' ? `${claude.total_cost_usd} $` : 'inconnu';
  const duration = typeof claude.duration_ms === 'number' ? claude.duration_ms : wallMs;
  const parts = [`coût ${cost}`];
  if (typeof duration === 'number') parts.push(`durée ${seconds(duration)}`);
  if (typeof claude.num_turns === 'number') parts.push(`${claude.num_turns} tours`);
  log(`${name} : ${result.pass ? 'RÉUSSI' : 'ÉCHEC'} — ${parts.join(', ')}`);
  log(`  dossier : ${run.dir}`);
  log(`  run : ${run.runId ?? 'aucun'}${run.state ? ` (status ${run.state.status}, piste ${run.state.track})` : ''}`);
  if (claude.is_error) log(`  claude : erreur (${claude.subtype ?? 'sans détail'})`);
  if (run.metrics) {
    const agents = Object.entries(run.metrics.agents)
      .map(([agent, a]) => `${agent} ${a.calls} appel(s) ${seconds(a.durationMs)} ${a.tokens} tokens`);
    log(`  mesures : ${agents.join(' ; ') || 'aucun agent'} ; ${run.metrics.turns} tour(s), ${run.metrics.rejected} livrable(s) rejeté(s)`);
  }
  for (const failure of result.failures) log(`  - ${failure}`);
}

function verify(name, dir, log, wallMs) {
  const scenario = loadScenario(name);
  const run = collectRun(resolve(dir));
  const result = evaluate(run, scenario.expect);
  report(log, name, run, result, wallMs);
  return { run, result };
}

function parseClaudeOutput({ code, stdout, stderr }) {
  try {
    return { ...JSON.parse(stdout), exitCode: code };
  } catch {
    return { exitCode: code, raw: stdout.slice(-20000), stderr: stderr.slice(-20000) };
  }
}

async function runScenario(name, { flags, deps, log }) {
  const budgetUsd = positiveNumber(flags['--budget-usd'] ?? 3, '--budget-usd');
  const maxTurns = positiveNumber(flags['--max-turns'] ?? 300, '--max-turns', true);
  const { dir, scenario } = prepare(name, { dir: flags['--dir'] });
  log(`${name} : projet prêt dans ${dir}, lancement de claude (budget ${budgetUsd} $)…`);
  const started = Date.now();
  const output = await runClaude({
    args: claudeArgs({ request: scenario.request, budgetUsd, maxTurns }),
    cwd: dir,
    env: childEnv(deps.env),
    spawn: deps.spawn,
    platform: deps.platform,
    exists: deps.exists,
    onStderr: deps.onStderr,
  });
  const wallMs = Date.now() - started;
  mkdirSync(join(dir, '.agent-runs'), { recursive: true });
  writeFileSync(join(dir, CLAUDE_RESULT), `${JSON.stringify(parseClaudeOutput(output), null, 2)}\n`);
  const { run, result } = verify(name, dir, log, wallMs);
  const summary = { scenario: name, pass: result.pass, failures: result.failures, runId: run.runId, wallMs, claude: run.claude };
  writeFileSync(join(dir, '.agent-runs', 'bench-report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return result.pass;
}

/**
 * @param {string[]} args arguments après le nom du script
 * @param {{ spawn?, env?, log?, platform?, exists?, onStderr? }} deps injectables (tests)
 */
export async function main(args, deps = {}) {
  const log = deps.log ?? console.log;
  const env = deps.env ?? process.env;
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    log(`erreur : ${err.message}\n${USAGE}`);
    return 2;
  }
  const { positional: [command, ...rest], flags } = parsed;
  try {
    switch (command) {
      case 'list':
        for (const name of listScenarios()) log(`${name.padEnd(18)} ${loadScenario(name).description ?? ''}`);
        return 0;
      case 'prepare': {
        if (rest.length !== 1) break;
        const { dir } = prepare(rest[0], { dir: flags['--dir'] });
        log(dir);
        return 0;
      }
      case 'verify': {
        if (rest.length !== 2) break;
        return verify(rest[0], rest[1], log).result.pass ? 0 : 1;
      }
      case 'run': {
        if (rest.length !== 1) break;
        if (!flags.yes && env.BENCH_ALLOW_API !== '1') {
          log('run appelle la vraie API Claude (coût réel) : ajoute --yes ou définis BENCH_ALLOW_API=1.');
          return 2;
        }
        const names = rest[0] === 'all' ? listScenarios() : [rest[0]];
        if (names.length > 1 && flags['--dir']) {
          log('erreur : --dir ne s\'utilise qu\'avec un seul scénario');
          return 2;
        }
        for (const name of names) loadScenario(name);
        let allPass = true;
        for (const name of names) {
          allPass = (await runScenario(name, { flags, deps: { ...deps, env }, log })) && allPass;
        }
        if (names.length > 1) log(allPass ? 'Tous les scénarios ont réussi.' : 'Au moins un scénario a échoué.');
        return allPass ? 0 : 1;
      }
      default:
        break;
    }
  } catch (err) {
    log(`erreur : ${err.message}`);
    return 2;
  }
  log(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { onStderr: (chunk) => process.stderr.write(chunk) })
    .then((code) => { process.exitCode = code; });
}
