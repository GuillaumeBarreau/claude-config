#!/usr/bin/env node
// Vérifie le state.json d'un run /team : structure, valeurs autorisées et règles de
// passage entre les étapes. Les portes ne dépendent pas du jugement du modèle : ce
// script refuse un état qui les contourne.
//
// Usage : node check-state.mjs <chemin/vers/state.json> [chemin/vers/team.json]
//   team.json par défaut : .claude/team.json du dossier courant, s'il existe. Il sert à
//   vérifier que les contrôles obligatoires du projet figurent bien dans le run.
// Sortie : 0 si l'état est valide, 1 sinon (erreurs sur stderr).
//
// Limite : le script juge un état, pas son historique. Il ne voit pas, par exemple, une
// piste passée de standard à quick ; le journal (log) doit le tracer.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RUN_STATUSES = [
  'qualifying', 'specifying', 'awaiting_input', 'planning', 'awaiting_plan_approval',
  'ready_for_execution', 'executing', 'checking', 'reviewing',
  'awaiting_delivery_approval', 'done', 'blocked', 'cancelled',
];
export const TRACKS = ['quick', 'standard', 'full'];
export const TASK_STATUSES = ['draft', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'failed'];
export const TASK_TYPES = ['feature', 'bug', 'refactoring', 'test', 'documentation', 'infrastructure'];
export const PRIORITIES = ['P0', 'P1', 'P2'];
export const COMPLEXITIES = ['S', 'M', 'L'];
export const CHECK_STATUSES = ['not_run', 'passed', 'failed', 'n/a'];
export const GATE_STATUSES = ['pending', 'passed', 'failed', 'waived'];
export const GATES = ['plan', 'checks', 'review', 'delivery'];

// Statuts qui supposent un plan validé (porte 1).
const AFTER_PLAN = [
  'ready_for_execution', 'executing', 'checking', 'reviewing',
  'awaiting_delivery_approval', 'done',
];
const CLEARED = ['passed', 'waived'];
// Portes que seul l'utilisateur peut valider ; toute dérogation (waived) aussi.
const USER_GATES = ['plan', 'delivery'];

const isString = (v) => typeof v === 'string' && v.trim() !== '';
const isArray = Array.isArray;

function oneOf(errors, where, value, allowed) {
  if (!allowed.includes(value)) {
    errors.push(`${where} : « ${value} » n'est pas une valeur autorisée (${allowed.join(', ')})`);
  }
}

function checkTasks(state, errors) {
  if (!isArray(state.tasks)) {
    errors.push('tasks : doit être une liste');
    return;
  }
  const ids = new Set();
  for (const [i, task] of state.tasks.entries()) {
    const where = `tasks[${i}]${task && task.id ? ` (${task.id})` : ''}`;
    if (!task || typeof task !== 'object') {
      errors.push(`${where} : doit être un objet`);
      continue;
    }
    for (const key of ['id', 'title', 'description']) {
      if (!isString(task[key])) errors.push(`${where}.${key} : obligatoire`);
    }
    if (ids.has(task.id)) errors.push(`${where} : identifiant en double`);
    ids.add(task.id);
    oneOf(errors, `${where}.type`, task.type, TASK_TYPES);
    oneOf(errors, `${where}.priority`, task.priority, PRIORITIES);
    oneOf(errors, `${where}.complexity`, task.complexity, COMPLEXITIES);
    oneOf(errors, `${where}.status`, task.status, TASK_STATUSES);
    for (const key of ['acceptanceCriteria', 'dependsOn', 'files', 'tests', 'risks']) {
      if (!isArray(task[key])) errors.push(`${where}.${key} : doit être une liste`);
    }
    if (typeof task.requiresHuman !== 'boolean') {
      errors.push(`${where}.requiresHuman : doit être true ou false`);
    }
    const checks = task.validation && task.validation.checks;
    if (task.status === 'done' && !['passed', 'n/a'].includes(checks)) {
      errors.push(`${where} : « done » exige validation.checks à passed ou n/a (actuel : ${checks})`);
    }
  }

  // Dépendances : existence puis absence de cycle.
  const deps = new Map(state.tasks.filter((t) => t && t.id).map((t) => [t.id, t.dependsOn || []]));
  for (const [id, list] of deps) {
    for (const dep of isArray(list) ? list : []) {
      if (!deps.has(dep)) errors.push(`tasks (${id}).dependsOn : tâche inconnue « ${dep} »`);
    }
  }
  const visited = new Map(); // 1 = en cours de visite, 2 = terminé
  const visit = (id, path) => {
    if (visited.get(id) === 2 || !deps.has(id)) return;
    if (visited.get(id) === 1) {
      errors.push(`tasks : cycle de dépendances (${[...path, id].join(' → ')})`);
      return;
    }
    visited.set(id, 1);
    for (const dep of isArray(deps.get(id)) ? deps.get(id) : []) visit(dep, [...path, id]);
    visited.set(id, 2);
  };
  for (const id of deps.keys()) visit(id, []);
}

function checkChecks(state, errors) {
  if (!isArray(state.checks)) {
    errors.push('checks : doit être une liste');
    return;
  }
  for (const [i, check] of state.checks.entries()) {
    const where = `checks[${i}]${check && check.name ? ` (${check.name})` : ''}`;
    if (!isString(check && check.name)) errors.push(`${where}.name : obligatoire`);
    if (!isString(check && check.command)) errors.push(`${where}.command : obligatoire`);
    if (typeof (check && check.required) !== 'boolean') {
      errors.push(`${where}.required : doit être true ou false`);
    }
    oneOf(errors, `${where}.status`, check && check.status, CHECK_STATUSES);
  }
}

function checkGates(state, errors) {
  const gates = state.gates;
  if (!gates || typeof gates !== 'object') {
    errors.push('gates : obligatoire');
    return false;
  }
  for (const name of GATES) {
    const gate = gates[name];
    if (!gate || typeof gate !== 'object') {
      errors.push(`gates.${name} : obligatoire`);
      continue;
    }
    oneOf(errors, `gates.${name}.status`, gate.status, GATE_STATUSES);
    if (CLEARED.includes(gate.status) && !isString(gate.by)) {
      errors.push(`gates.${name} : « ${gate.status} » exige « by » (qui a validé)`);
    } else if ((gate.status === 'waived' || (gate.status === 'passed' && USER_GATES.includes(name)))
        && gate.by !== 'user') {
      errors.push(`gates.${name} : « ${gate.status} » ne peut être décidé que par l'utilisateur (by: "user"), pas « ${gate.by} »`);
    }
    if (gate.status === 'waived' && !isString(gate.notes)) {
      errors.push(`gates.${name} : « waived » exige une justification dans « notes »`);
    }
  }
  return GATES.every((name) => gates[name] && typeof gates[name] === 'object');
}

function checkRules(state, errors, team) {
  const gate = (name) => state.gates[name].status;
  const requireCleared = (names, reason) => {
    for (const name of names) {
      if (!CLEARED.includes(gate(name))) errors.push(`${reason} exige gates.${name} validée ; actuel : ${gate(name)}`);
    }
  };
  const tasks = isArray(state.tasks) ? state.tasks.filter(Boolean) : [];
  const checks = isArray(state.checks) ? state.checks.filter(Boolean) : [];

  if (state.track !== 'quick' && AFTER_PLAN.includes(state.status)) {
    if (!CLEARED.includes(gate('plan'))) {
      errors.push(`status « ${state.status} » exige gates.plan validée (porte 1) ; actuel : ${gate('plan')}`);
    }
    if (!tasks.length) errors.push(`status « ${state.status} » exige au moins une tâche`);
    for (const task of tasks.filter((t) => t.status === 'draft')) {
      errors.push(`status « ${state.status} » : la tâche ${task.id} est encore « draft » (attendu : ready ou suivant)`);
    }
  }

  // Porte 2 : contrôles obligatoires réellement présents et réussis.
  if (team && isArray(team.checks)) {
    for (const required of team.checks.filter((c) => c && c.required)) {
      if (!checks.some((c) => c.name === required.name)) {
        errors.push(`checks : le contrôle obligatoire « ${required.name} » de team.json est absent du run`);
      }
    }
  }
  if (gate('checks') === 'passed') {
    if (!checks.length) {
      errors.push('gates.checks « passed » sans aucun contrôle dans le run (sinon : « waived » par l\'utilisateur, justifié)');
    }
    for (const check of checks) {
      if (check.required && !['passed', 'n/a'].includes(check.status)) {
        errors.push(`gates.checks « passed » alors que le contrôle obligatoire « ${check.name} » est ${check.status}`);
      }
    }
  }

  if (gate('delivery') === 'passed') requireCleared(['checks', 'review'], 'gates.delivery « passed »');
  if (state.status === 'awaiting_delivery_approval') requireCleared(['checks', 'review'], 'status « awaiting_delivery_approval »');
  if (state.status === 'done') {
    requireCleared(['checks', 'review'], 'status « done »');
    if (state.track !== 'quick') {
      for (const task of tasks.filter((t) => t.status !== 'done')) {
        errors.push(`status « done » : la tâche ${task.id} est « ${task.status} »`);
      }
    }
  }
  if (state.status === 'blocked' && !isString(state.blockedReason)) {
    errors.push('status « blocked » exige « blockedReason »');
  }
  if (state.status === 'awaiting_input' && !(isArray(state.openQuestions) && state.openQuestions.length)) {
    errors.push('status « awaiting_input » exige au moins une entrée dans « openQuestions »');
  }
}

/** @param team contenu de .claude/team.json (facultatif). */
export function checkState(state, team = null) {
  const errors = [];
  if (!state || typeof state !== 'object' || isArray(state)) return ['state.json doit être un objet JSON'];
  if (!isString(state.id)) errors.push('id : obligatoire');
  oneOf(errors, 'track', state.track, TRACKS);
  oneOf(errors, 'status', state.status, RUN_STATUSES);
  if (!isArray(state.log)) errors.push('log : doit être une liste');
  checkTasks(state, errors);
  checkChecks(state, errors);
  if (checkGates(state, errors)) checkRules(state, errors, team);
  return errors;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error('Usage : node check-state.mjs <chemin/vers/state.json> [chemin/vers/team.json]');
    return 1;
  }
  const teamFile = argv[3] ?? (existsSync('.claude/team.json') ? '.claude/team.json' : null);
  let state;
  let team = null;
  try {
    state = readJson(file);
    if (teamFile) team = readJson(teamFile);
  } catch (err) {
    console.error(`lecture ou JSON invalide — ${err.message}`);
    return 1;
  }
  const errors = checkState(state, team);
  if (errors.length) {
    console.error(`${file} : ${errors.length} erreur(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log(`${file} : OK (status ${state.status})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
