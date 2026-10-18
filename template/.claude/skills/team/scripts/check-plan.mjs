#!/usr/bin/env node
// Vérifie un plan avant la porte 1 : ce que la revue du plan demandait à l'orchestrateur
// devient un contrôle déterministe. Croise spec.md (critères d'acceptation), le bloc des
// tâches de plan.md et les tâches de state.json.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team/scripts/check-plan.mjs .agent-runs/<id> [--record]
//   --record : écrit state.planCheck (status, at, by "check-plan", digest, errors) et
//   l'événement plan_checked. check-state exige ce planCheck, à jour, pour valider le
//   plan (schéma 2).
// Sortie : 0 plan conforme (ou piste quick : sans objet), 1 erreurs, 2 usage ou lecture.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkState, dependencyErrors, isPlanTask, planDigest } from './check-state.mjs';
import { sensitiveFiles, teamSensitivePaths } from './sensitive.mjs';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMPARED = ['id', 'files', 'newFiles', 'acceptanceCriteria', 'dependsOn', 'requiresHuman'];
const FREE_FILES_ORIGINS = ['ci', 'pr-review'];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const list = (v) => (Array.isArray(v) ? v : []);
const filesOf = (t) => [...list(t.files), ...list(t.newFiles)];

/** Contenu d'une section « ## <titre> » (jusqu'au titre ## suivant), ou null. */
function section(markdown, title) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => title.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** Critères d'acceptation de spec.md : puces **ACn**, sinon toute mention ACn de la section. */
export function specCriteria(spec) {
  const body = section(spec, /^##\s+Crit[eè]res d['’]acceptation\s*$/i);
  if (body === null) return [];
  const bullets = [...body.matchAll(/^\s*[-*]\s+\*\*(AC\d+)\*\*/gm)].map((m) => m[1]);
  const ids = bullets.length ? bullets : [...body.matchAll(/\bAC\d+\b/g)].map((m) => m[0]);
  return [...new Set(ids)];
}

/** Dernier bloc ```json de la section « Bloc des tâches » de plan.md. */
export function planBlock(plan) {
  const body = section(plan, /^##\s+Bloc des t[âa]ches\s*$/i);
  if (body === null) throw new Error('plan.md : section « Bloc des tâches » absente');
  const blocks = [...body.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error('plan.md : aucun bloc ```json dans « Bloc des tâches »');
  let tasks;
  try {
    tasks = JSON.parse(blocks.at(-1)[1]);
  } catch (err) {
    throw new Error(`plan.md : bloc des tâches JSON invalide — ${err.message}`);
  }
  if (!Array.isArray(tasks)) throw new Error('plan.md : le bloc des tâches doit être une liste');
  return tasks;
}

function pathProblem(path) {
  if (typeof path !== 'string' || !path.trim()) return 'chemin vide ou non textuel';
  if (/^([a-zA-Z]:)?[\\/]/.test(path)) return 'chemin absolu (attendu : relatif à la racine du projet)';
  if (path.split(/[\\/]/).includes('..')) return 'chemin avec « .. »';
  if (path.includes('…')) return 'chemin avec « … » (à compléter)';
  if (/<[^>]*>/.test(path)) return 'chemin avec « <…> » (à compléter)';
  if (/[*?[\]{}]/.test(path)) return 'glob interdit (un fichier par entrée)';
  return null;
}

const normalized = (task, key) => JSON.stringify(key === 'newFiles' ? (task.newFiles ?? []) : task[key]);

/**
 * dependsOn de plan.md et de state.json concordent-ils ? Une dépendance vers une tâche
 * redécoupée (replaced : id → ids de ses tâches split) est satisfaite par n'importe quel
 * sous-ensemble non vide de ses remplaçantes ; les autres doivent être identiques.
 */
function sameDependsOn(planned, actual, replaced) {
  const plannedDeps = planned.dependsOn;
  if (!Array.isArray(plannedDeps) || !plannedDeps.some((d) => replaced.has(d))) {
    return normalized(planned, 'dependsOn') === normalized(actual, 'dependsOn');
  }
  const actualDeps = list(actual.dependsOn);
  const kept = plannedDeps.filter((d) => !replaced.has(d));
  const allowed = new Set(kept);
  for (const d of plannedDeps.filter((x) => replaced.has(x))) {
    const substitutes = replaced.get(d);
    if (!actualDeps.some((a) => substitutes.includes(a))) return false;
    for (const s of substitutes) allowed.add(s);
  }
  return kept.every((d) => actualDeps.includes(d)) && actualDeps.every((a) => allowed.has(a))
    && new Set(actualDeps).size === actualDeps.length;
}

/**
 * @returns { status: "passed"|"failed"|"n/a", errors, warnings, digest }
 */
export function checkPlan(runDir, { projectDir = dirname(CLAUDE_DIR), sensitivePaths = teamSensitivePaths() } = {}) {
  const state = readJson(join(runDir, 'state.json'));
  if (state.track === 'quick') return { status: 'n/a', errors: [], warnings: [], digest: null };
  const errors = [];
  const warnings = [];
  const tasks = list(state.tasks).filter((t) => t && typeof t === 'object');

  // Critères d'acceptation : chacun couvert, aucun inconnu.
  const specPath = join(runDir, 'spec.md');
  const criteria = existsSync(specPath) ? specCriteria(readFileSync(specPath, 'utf8')) : null;
  if (criteria === null) errors.push('spec.md absent du run');
  else if (!criteria.length) errors.push('spec.md : aucun critère d\'acceptation (section « Critères d\'acceptation », puces **AC1**…)');
  else {
    const cited = new Set(tasks.flatMap((t) => list(t.acceptanceCriteria)));
    for (const ac of criteria.filter((c) => !cited.has(c))) errors.push(`${ac} n'est couvert par aucune tâche`);
    for (const t of tasks) {
      for (const ac of list(t.acceptanceCriteria).filter((c) => !criteria.includes(c))) {
        errors.push(`${t.id} cite ${ac}, absent de spec.md`);
      }
    }
  }

  // Bloc de plan.md ↔ tâches de state.json (origine plan ; une tâche redécoupée est
  // remplacée par ses tâches split, y compris dans les dependsOn des tâches aval).
  const planPath = join(runDir, 'plan.md');
  if (!existsSync(planPath)) errors.push('plan.md absent du run');
  else {
    try {
      const block = planBlock(readFileSync(planPath, 'utf8'));
      const planTasks = tasks.filter((t) => (t.origin ?? 'plan') === 'plan');
      const replaced = new Map();
      for (const t of tasks.filter((x) => x.origin === 'split')) {
        replaced.set(t.splitFrom, [...(replaced.get(t.splitFrom) ?? []), t.id]);
      }
      const byId = new Map(planTasks.map((t) => [t.id, t]));
      const blockIds = new Set(block.map((t) => t && t.id));
      for (const planned of block.filter((t) => t && typeof t === 'object')) {
        const actual = byId.get(planned.id);
        if (!actual) {
          if (!replaced.has(planned.id)) errors.push(`${planned.id} : présente dans plan.md, absente de state.json`);
          continue;
        }
        const diff = COMPARED.filter((k) => (k === 'dependsOn'
          ? !sameDependsOn(planned, actual, replaced)
          : normalized(planned, k) !== normalized(actual, k)));
        if (diff.length) errors.push(`${planned.id} : plan.md et state.json diffèrent sur ${diff.join(', ')}`);
      }
      for (const t of planTasks.filter((x) => !blockIds.has(x.id))) {
        errors.push(`${t.id} : présente dans state.json, absente du bloc de plan.md`);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  // Fichiers : chemins exploitables, existants ou créés par une tâche du plan.
  const created = new Set(tasks.flatMap((t) => list(t.newFiles)));
  for (const t of tasks) {
    for (const path of filesOf(t)) {
      const problem = pathProblem(path);
      if (problem) errors.push(`${t.id} : ${path} — ${problem}`);
    }
    for (const path of list(t.files).filter((p) => !pathProblem(p))) {
      if (!existsSync(join(projectDir, path)) && !created.has(path)) {
        errors.push(`${t.id} : ${path} : absent du disque et absent de newFiles (fichier à créer → newFiles)`);
      }
    }
    for (const path of list(t.newFiles).filter((p) => !pathProblem(p))) {
      if (existsSync(join(projectDir, path))) warnings.push(`${t.id} : ${path} : déjà présent alors qu'il figure dans newFiles`);
    }
    if (!t.requiresHuman) {
      for (const { path, category } of sensitiveFiles(filesOf(t).filter((p) => !pathProblem(p)), sensitivePaths)) {
        errors.push(`${t.id} : ${path} est sensible (${category}) mais requiresHuman vaut false`);
      }
    }
    if (isPlanTask(t) && !FREE_FILES_ORIGINS.includes(t.origin) && !filesOf(t).length) {
      errors.push(`${t.id} : aucune entrée dans files ni newFiles`);
    }
  }
  errors.push(...dependencyErrors(tasks));

  return { status: errors.length ? 'failed' : 'passed', errors, warnings, digest: planDigest(tasks) };
}

function main(argv) {
  const args = argv.slice(2);
  const record = args.includes('--record');
  const runArg = args.find((a) => !a.startsWith('--'));
  if (!runArg) {
    console.error('Usage : node check-plan.mjs .agent-runs/<id> [--record]');
    return 2;
  }
  const runDir = resolve(runArg);
  const statePath = join(runDir, 'state.json');
  let result;
  try {
    if (!existsSync(statePath)) throw new Error(`${statePath} introuvable`);
    result = checkPlan(runDir);
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 2;
  }
  if (result.status === 'n/a') {
    console.log('check-plan : piste quick, sans objet.');
    return 0;
  }
  for (const w of result.warnings) console.log(`avertissement : ${w}`);
  for (const e of result.errors) console.error(`erreur : ${e}`);
  if (record) {
    const state = readJson(statePath);
    const at = new Date().toISOString();
    state.planCheck = { status: result.status, at, by: 'check-plan', digest: result.digest, errors: result.errors };
    state.updatedAt = at;
    if (!Array.isArray(state.log)) state.log = [];
    state.log.push({ at, actor: 'check-plan', event: 'plan_checked', detail: result.errors.length ? `failed (${result.errors.length} erreur(s))` : 'passed' });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const teamPath = join(CLAUDE_DIR, 'team.json');
    const team = existsSync(teamPath) ? readJson(teamPath) : null;
    for (const e of checkState(state, team)) console.error(`state.json : ${e}`);
  }
  console.log(`check-plan : ${result.status}${record ? ' (enregistré dans state.json)' : ''}`);
  return result.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
