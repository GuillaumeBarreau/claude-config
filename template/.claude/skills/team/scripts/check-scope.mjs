#!/usr/bin/env node
// Compare les fichiers réellement modifiés (Git) au périmètre prévu par le plan, avant le
// commit d'une tâche. Ce que l'orchestrateur faisait « à l'œil » devient un constat écrit
// dans state.json, exigé par check-state pour passer une tâche à done (schéma 2).
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team/scripts/check-scope.mjs .agent-runs/<id> [--task Tn]
//   --task : compare à files ∪ newFiles de la tâche et écrit task.scope ;
//   sans --task (piste quick) : écrit state.scope (pas de plan : seules les zones
//   sensibles comptent).
// Fichiers modifiés : indexés, non indexés et non suivis (renommage → destination),
// hors .agent-runs/ et .claude/worktrees/. Un test non prévu est toléré (outOfPlanTests).
// Sortie : 0 conforme, 1 écart (hors plan) ou fichier sensible, 2 erreur.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizePath, sensitiveFiles, teamSensitivePaths } from './sensitive.mjs';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXCLUDED = [/^\.agent-runs\//, /^\.claude\/worktrees\//];
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const list = (v) => (Array.isArray(v) ? v : []);
const sameSet = (a, b) => JSON.stringify([...list(a)].sort()) === JSON.stringify([...list(b)].sort());

/** Sortie de `git status --porcelain=v1 -z` → chemins (destination pour un renommage). */
export function parsePorcelain(output) {
  const entries = output.split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(xy)) i++; // l'entrée suivante est le chemin d'origine
  }
  return paths;
}

/** Fichiers modifiés du projet, relatifs à sa racine, triés et sans doublon. */
export function changedFiles(projectDir) {
  const run = (...args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = run('rev-parse', '--show-prefix').trim();
  const paths = parsePorcelain(run('status', '--porcelain=v1', '-z', '-uall'))
    .map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p))
    .map(normalizePath)
    .filter((p) => !EXCLUDED.some((re) => re.test(p)));
  return [...new Set(paths)].sort();
}

/** Calcul pur du périmètre. plan = { files, newFiles, requiresHuman } ou null (pas de plan). */
export function computeScope(changed, plan, sensitivePaths = [], now = new Date().toISOString()) {
  const planned = new Set(plan ? [...list(plan.files), ...list(plan.newFiles)].map(normalizePath) : []);
  const unplanned = plan ? changed.filter((p) => !planned.has(p)) : [];
  const outOfPlanTests = unplanned.filter((p) => TEST_FILE.test(p));
  const outOfPlan = unplanned.filter((p) => !TEST_FILE.test(p));
  const sensitive = plan && plan.requiresHuman ? [] : sensitiveFiles(changed, sensitivePaths);
  return {
    status: sensitive.length ? 'sensitive' : outOfPlan.length ? 'deviation' : 'ok',
    changed,
    outOfPlan,
    outOfPlanTests,
    sensitive,
    at: now,
    by: 'check-scope',
    justification: '',
    approvedBy: null,
  };
}

/**
 * Calcule et enregistre le périmètre dans <runDir>/state.json.
 * @returns { code: 0|1, scope }  (lève une erreur si le run, la tâche ou Git manque)
 */
export function checkScope(runDir, { projectDir = dirname(CLAUDE_DIR), taskId = null, sensitivePaths = teamSensitivePaths() } = {}) {
  const statePath = join(runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`${statePath} introuvable`);
  const state = readJson(statePath);
  const tasks = list(state.tasks).filter((t) => t && typeof t === 'object');
  const task = taskId ? tasks.find((t) => t.id === taskId) : null;
  if (taskId && !task) throw new Error(`tâche « ${taskId} » absente de ${statePath}`);

  let changed;
  try {
    changed = changedFiles(projectDir);
  } catch (err) {
    throw new Error(`git status impossible (${String(err.stderr || err.message).trim()})`);
  }
  // Sans --task : pas de plan en piste quick ; sinon, le périmètre du run entier.
  const plan = task ?? (tasks.length
    ? { files: tasks.flatMap((t) => list(t.files)), newFiles: tasks.flatMap((t) => list(t.newFiles)), requiresHuman: false }
    : null);
  const scope = computeScope(changed, plan, sensitivePaths);

  // Une justification ou un accord restent valables tant que l'écart n'a pas changé.
  const previous = (task ?? state).scope;
  if (previous && typeof previous === 'object') {
    if (scope.outOfPlan.length && sameSet(previous.outOfPlan, scope.outOfPlan)) scope.justification = previous.justification ?? '';
    const paths = (s) => list(s).map((x) => x && x.path);
    if (scope.sensitive.length && sameSet(paths(previous.sensitive), paths(scope.sensitive))) scope.approvedBy = previous.approvedBy ?? null;
  }

  if (task) task.scope = scope;
  else state.scope = scope;
  state.updatedAt = scope.at;
  if (!Array.isArray(state.log)) state.log = [];
  const deviation = scope.status !== 'ok';
  state.log.push({
    at: scope.at,
    actor: 'check-scope',
    event: deviation ? 'scope_deviation' : 'scope_checked',
    detail: `${taskId ?? 'run'} : ${scope.status}${scope.outOfPlan.length ? ` ; hors plan : ${scope.outOfPlan.join(', ')}` : ''}`
      + `${scope.sensitive.length ? ` ; sensibles : ${scope.sensitive.map((s) => s.path).join(', ')}` : ''}`,
  });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { code: deviation ? 1 : 0, scope };
}

function main(argv) {
  const args = argv.slice(2);
  const taskIndex = args.indexOf('--task');
  const taskId = taskIndex >= 0 ? args[taskIndex + 1] : null;
  const runArg = args.find((a, i) => !a.startsWith('--') && (taskIndex < 0 || i !== taskIndex + 1));
  if (!runArg || (taskIndex >= 0 && !taskId)) {
    console.error('Usage : node check-scope.mjs .agent-runs/<id> [--task Tn]');
    return 2;
  }
  let result;
  try {
    result = checkScope(resolve(runArg), { taskId });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 2;
  }
  const { scope } = result;
  console.log(`check-scope ${taskId ?? '(run)'} : ${scope.status} — ${scope.changed.length} fichier(s) modifié(s)`);
  if (scope.outOfPlan.length) console.log(`  hors plan : ${scope.outOfPlan.join(', ')}`);
  if (scope.outOfPlanTests.length) console.log(`  tests non prévus (tolérés) : ${scope.outOfPlanTests.join(', ')}`);
  for (const s of scope.sensitive) console.log(`  sensible : ${s.path} (${s.category})`);
  if (scope.status === 'deviation') console.log('  → justifie l\'écart dans scope.justification, ou fais-le corriger.');
  if (scope.status === 'sensitive') console.log('  → accord explicite de l\'utilisateur requis (scope.approvedBy: "user").');
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
