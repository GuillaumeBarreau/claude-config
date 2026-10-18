#!/usr/bin/env node
// Exécute les contrôles de .claude/team.json pour un run /team et enregistre les
// résultats réels dans son state.json. Le statut d'un contrôle et la porte 2 viennent
// du code de sortie des commandes, jamais de ce qu'un agent affirme.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team/scripts/run-checks.mjs .agent-runs/<id> [--task T1]
//
// - Chaque contrôle est lancé depuis la racine du projet ; sa sortie complète va dans
//   .agent-runs/<id>/checks/<nom>.log, ses dernières lignes dans « summary ».
// - gates.checks passe à passed (by "run-checks") si tous les contrôles obligatoires
//   réussissent, à failed sinon.
// - --task : enregistre aussi le résultat et les journaux sur la tâche.
// Sortie : 0 si tous les obligatoires réussissent, 1 sinon ou en cas d'erreur.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkState } from './check-state.mjs';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_TIMEOUT_S = 900;
const SUMMARY_LINES = 8;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

function runOne(check, cwd) {
  const started = Date.now();
  const res = spawnSync(check.command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: (check.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  let note = '';
  if (res.error) note = `\n[run-checks] ${res.error.code === 'ETIMEDOUT' ? 'délai dépassé' : res.error.message}`;
  return {
    passed: res.status === 0 && !res.error,
    exitCode: res.status,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    output: output + note,
  };
}

const summarize = (output) => output.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
  .slice(-SUMMARY_LINES).join('\n');

/**
 * Lance les contrôles et met à jour <runDir>/state.json.
 * Renvoie { ok, results, errors } ; errors = erreurs de check-state après mise à jour.
 */
export function runChecks({ claudeDir = CLAUDE_DIR, runDir, taskId = null }) {
  const projectDir = dirname(claudeDir);
  const team = readJson(join(claudeDir, 'team.json'));
  const checks = Array.isArray(team.checks) ? team.checks : [];
  if (!team.initialized || !checks.length) {
    throw new Error('aucun contrôle configuré dans .claude/team.json — lance /team-init');
  }
  const statePath = join(runDir, 'state.json');
  const state = readJson(statePath);
  const task = taskId ? (state.tasks ?? []).find((t) => t && t.id === taskId) : null;
  if (taskId && !task) throw new Error(`tâche « ${taskId} » absente de ${statePath}`);

  mkdirSync(join(runDir, 'checks'), { recursive: true });
  const at = new Date().toISOString();
  const results = checks.map((check) => {
    const run = runOne(check, projectDir);
    const log = `checks/${check.name.replace(/[^\w.-]+/g, '_')}.log`;
    writeFileSync(join(runDir, log), `$ ${check.command}\n${run.output}\n[run-checks] code ${run.exitCode}, ${run.seconds} s\n`);
    return {
      name: check.name,
      command: check.command,
      required: check.required === true,
      status: run.passed ? 'passed' : 'failed',
      at,
      summary: summarize(run.output) || `(aucune sortie, code ${run.exitCode})`,
      log,
    };
  });

  const ok = results.every((r) => !r.required || r.status === 'passed');
  // Les contrôles du run reflètent team.json ; un contrôle déclaré n/a à la main reste n/a.
  const previous = new Map((state.checks ?? []).map((c) => [c && c.name, c]));
  state.checks = results.map((r) => (previous.get(r.name)?.status === 'n/a' && r.status === 'failed'
    ? { ...r, status: 'n/a', summary: `${previous.get(r.name).summary ?? ''} (dernier essai : échec)` }
    : r));
  state.gates.checks = {
    status: ok ? 'passed' : 'failed',
    by: 'run-checks',
    at,
    notes: results.filter((r) => r.status === 'failed').map((r) => `${r.name} en échec`).join(', '),
  };
  if (task) {
    task.validation = task.validation ?? {};
    task.validation.checks = ok ? 'passed' : 'failed';
    task.validation.evidence = [...(task.validation.evidence ?? []), ...results.map((r) => `${r.log} (${r.status}, ${at})`)];
  }
  state.updatedAt = at;
  if (Array.isArray(state.log)) {
    state.log.push({ at, actor: 'run-checks', event: ok ? 'checks_passed' : 'checks_failed', detail: taskId ?? 'run' });
  }
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { ok, results, errors: checkState(state, team) };
}

function main(argv) {
  const args = argv.slice(2);
  const taskIndex = args.indexOf('--task');
  const taskId = taskIndex >= 0 ? args[taskIndex + 1] : null;
  const runDir = args.find((a, i) => !a.startsWith('--') && (taskIndex < 0 || i !== taskIndex + 1));
  if (!runDir || (taskIndex >= 0 && !taskId)) {
    console.error('Usage : node run-checks.mjs .agent-runs/<id> [--task T1]');
    return 1;
  }
  let outcome;
  try {
    outcome = runChecks({ runDir: resolve(runDir), taskId });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 1;
  }
  for (const r of outcome.results) {
    console.log(`${r.name.padEnd(12)} ${r.status.padEnd(7)} ${r.required ? 'obligatoire' : 'facultatif '}  ${r.command}`);
    if (r.status === 'failed') console.log(`  journal : ${join(runDir, r.log)}\n${r.summary.replace(/^/gm, '  | ')}`);
  }
  for (const e of outcome.errors) console.error(`state.json : ${e}`);
  console.log(outcome.ok ? 'Porte 2 : passed' : 'Porte 2 : failed');
  return outcome.ok && !outcome.errors.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
