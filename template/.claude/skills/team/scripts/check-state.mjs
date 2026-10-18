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
// Schéma 2 (« schemaVersion »: 2, à partir de 0.3) : règles en plus sur la vérification du
// plan (check-plan), le périmètre des tâches (check-scope) et la CI. Un state.json sans
// schemaVersion (runs 0.2) reste jugé avec les seules règles d'origine.
//
// Limite : le script juge un état, pas son historique. Il ne voit pas, par exemple, une
// piste passée de standard à quick ; le journal (log) doit le tracer.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RUN_STATUSES = [
  'qualifying', 'specifying', 'awaiting_input', 'planning', 'awaiting_plan_approval',
  'ready_for_execution', 'executing', 'checking', 'reviewing',
  'awaiting_delivery_approval', 'awaiting_ci', 'done', 'blocked', 'cancelled',
];
export const TRACKS = ['quick', 'standard', 'full'];
export const TASK_STATUSES = ['draft', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'failed'];
export const TASK_TYPES = ['feature', 'bug', 'refactoring', 'test', 'documentation', 'infrastructure'];
export const PRIORITIES = ['P0', 'P1', 'P2'];
export const COMPLEXITIES = ['S', 'M', 'L'];
export const CHECK_STATUSES = ['not_run', 'passed', 'failed', 'n/a'];
export const GATE_STATUSES = ['pending', 'passed', 'failed', 'waived'];
export const GATES = ['plan', 'checks', 'review', 'delivery'];
export const AUTONOMY = ['supervised', 'autonomous'];
// Schéma 2 (0.3) : vérifications déterministes du plan, du périmètre et de la CI.
export const SCHEMA_VERSION = 2;
export const TASK_ORIGINS = ['plan', 'split', 'ci', 'pr-review'];
export const PLAN_ORIGINS = ['plan', 'split'];
export const CI_STATUSES = ['pending', 'passed', 'failed', 'n/a'];
export const SCOPE_STATUSES = ['ok', 'deviation', 'sensitive'];
export const PLAN_CHECK_STATUSES = ['passed', 'failed'];

// Statuts qui supposent un plan validé (porte 1).
const AFTER_PLAN = [
  'ready_for_execution', 'executing', 'checking', 'reviewing',
  'awaiting_delivery_approval', 'awaiting_ci', 'done',
];
const CLEARED = ['passed', 'waived'];
// Portes que seul l'utilisateur peut valider ; toute dérogation (waived) aussi.
// Exception : en autonomie (team.json « autonomy »), l'orchestrateur peut valider le
// plan s'il ne contient aucune tâche requiresHuman et que la piste n'est pas full.
const USER_GATES = ['plan', 'delivery'];
// Statuts où des agents modifient le code : il faut une branche de travail.
const WORKING = ['executing', 'checking', 'reviewing'];
const DEFAULT_MAX_ATTEMPTS = 2;

const autonomousPlan = (state) => state.autonomy === 'autonomous'
  && state.gates.plan.status === 'passed' && state.gates.plan.by === 'orchestrator';

const isString = (v) => typeof v === 'string' && v.trim() !== '';
const isArray = Array.isArray;

function oneOf(errors, where, value, allowed) {
  if (!allowed.includes(value)) {
    errors.push(`${where} : « ${value} » n'est pas une valeur autorisée (${allowed.join(', ')})`);
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !isArray(v);
const originOf = (task) => task.origin ?? 'plan';
export const isPlanTask = (task) => Boolean(task) && PLAN_ORIGINS.includes(originOf(task));
export const schemaVersion = (state) => (Number.isInteger(state && state.schemaVersion) ? state.schemaVersion : 1);

/**
 * Empreinte du plan : ce que check-plan a vérifié. Tâches d'origine plan ou split,
 * triées par id, réduites aux champs qui fixent le périmètre. Changer un fichier, un
 * critère, une dépendance ou requiresHuman après la vérification change l'empreinte.
 */
export function planDigest(tasks) {
  const reduced = (isArray(tasks) ? tasks : []).filter(isPlanTask)
    .map((t) => ({
      id: t.id,
      files: t.files,
      newFiles: t.newFiles ?? [],
      acceptanceCriteria: t.acceptanceCriteria,
      dependsOn: t.dependsOn,
      requiresHuman: t.requiresHuman,
      // Agent hors défaut seulement : l'empreinte des runs antérieurs (implementer) ne change pas.
      ...(t.agent && t.agent !== 'implementer' ? { agent: t.agent } : {}),
    }))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(reduced)).digest('hex');
}

/** Dépendances inconnues et cycles (aussi utilisé par check-plan). */
export function dependencyErrors(tasks) {
  const errors = [];
  const deps = new Map((isArray(tasks) ? tasks : []).filter((t) => t && t.id).map((t) => [t.id, t.dependsOn || []]));
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
  return errors;
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
    const review = task.validation && task.validation.review;
    if (task.status === 'done' && review !== 'approve') {
      errors.push(`${where} : « done » exige validation.review à approve (actuel : ${review})`);
    }
    const max = (state.limits && state.limits.maxAttempts) ?? DEFAULT_MAX_ATTEMPTS;
    if (task.attempts > max && !['blocked', 'failed'].includes(task.status)) {
      errors.push(`${where} : ${task.attempts} tentatives > maxAttempts (${max}) — la tâche doit être blocked ou failed`);
    }
  }

  // Dépendances : existence puis absence de cycle.
  errors.push(...dependencyErrors(state.tasks));
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
        && gate.by !== 'user' && !(name === 'plan' && autonomousPlan(state))) {
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
  if (autonomousPlan(state)) {
    if (state.track === 'full') errors.push('gates.plan validée par l\'orchestrateur : interdit en piste full');
    for (const task of tasks.filter((t) => t.requiresHuman)) {
      errors.push(`gates.plan validée par l'orchestrateur malgré une tâche requiresHuman (${task.id}) : l'utilisateur doit valider`);
    }
  }
  if (WORKING.includes(state.status)) {
    if (!isString(state.branch)) errors.push(`status « ${state.status} » exige « branch » (branche de travail du run)`);
    else if (state.branch === state.baseBranch) {
      errors.push(`status « ${state.status} » : branch « ${state.branch} » est la branche de base — travaille sur une branche dédiée`);
    }
  }

  if (gate('checks') === 'passed') {
    if (state.gates.checks.by !== 'run-checks') {
      errors.push(`gates.checks « passed » exige by « run-checks » (posé par scripts/run-checks.mjs), pas « ${state.gates.checks.by} »`);
    }
    if (!checks.length) {
      errors.push('gates.checks « passed » sans aucun contrôle dans le run (sinon : « waived » par l\'utilisateur, justifié)');
    }
    for (const check of checks) {
      if (check.required && !['passed', 'n/a'].includes(check.status)) {
        errors.push(`gates.checks « passed » alors que le contrôle obligatoire « ${check.name} » est ${check.status}`);
      }
    }
  }

  if (gate('review') === 'passed' && state.track !== 'quick') {
    const pending = tasks.filter((t) => t.status !== 'done');
    if (pending.length) {
      errors.push(`gates.review « passed » exige toutes les tâches à done (${pending.map((t) => `${t.id} : ${t.status}`).join(', ')})`);
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

// --- Schéma 2 -----------------------------------------------------------------------

const isCount = (v) => Number.isInteger(v) && v >= 0;

function checkScopeShape(errors, where, scope) {
  if (scope === undefined || scope === null) return;
  if (!isObject(scope)) {
    errors.push(`${where} : doit être un objet`);
    return;
  }
  oneOf(errors, `${where}.status`, scope.status, SCOPE_STATUSES);
  for (const key of ['changed', 'outOfPlan', 'outOfPlanTests', 'sensitive']) {
    if (scope[key] !== undefined && !isArray(scope[key])) errors.push(`${where}.${key} : doit être une liste`);
  }
}

/** R5 : forme et valeurs des champs ajoutés par le schéma 2. */
function checkSchema2Fields(state, errors) {
  const pc = state.planCheck;
  if (pc !== undefined && pc !== null) {
    if (!isObject(pc)) errors.push('planCheck : doit être un objet');
    else {
      oneOf(errors, 'planCheck.status', pc.status, PLAN_CHECK_STATUSES);
      if (pc.errors !== undefined && !isArray(pc.errors)) errors.push('planCheck.errors : doit être une liste');
    }
  }
  checkScopeShape(errors, 'scope', state.scope);
  const ci = state.ci;
  if (ci !== undefined && ci !== null) {
    if (!isObject(ci)) errors.push('ci : doit être un objet');
    else {
      oneOf(errors, 'ci.status', ci.status, CI_STATUSES);
      if (ci.rounds !== undefined && !isCount(ci.rounds)) errors.push('ci.rounds : doit être un entier ≥ 0');
      if (ci.runs !== undefined && !isArray(ci.runs)) errors.push('ci.runs : doit être une liste');
    }
  }
  if (state.pr !== undefined && state.pr !== null && !isObject(state.pr)) errors.push('pr : doit être un objet');
  const prc = state.prComments;
  if (prc !== undefined && prc !== null) {
    if (!isObject(prc)) errors.push('prComments : doit être un objet');
    else if (prc.processed !== undefined && !isArray(prc.processed)) errors.push('prComments.processed : doit être une liste');
  }
  for (const [i, task] of (isArray(state.tasks) ? state.tasks : []).entries()) {
    if (!isObject(task)) continue;
    const where = `tasks[${i}]${task.id ? ` (${task.id})` : ''}`;
    if (task.origin !== undefined) oneOf(errors, `${where}.origin`, task.origin, TASK_ORIGINS);
    if (task.origin === 'split' && !isString(task.splitFrom)) {
      errors.push(`${where} : origin « split » exige « splitFrom » (id de la tâche redécoupée)`);
    }
    if (task.newFiles !== undefined && !isArray(task.newFiles)) errors.push(`${where}.newFiles : doit être une liste`);
    if (task.consultations !== undefined && !isCount(task.consultations)) {
      errors.push(`${where}.consultations : doit être un entier ≥ 0`);
    }
    checkScopeShape(errors, `${where}.scope`, task.scope);
  }
}

/** R1 à R4 : règles de passage du schéma 2 (les portes sont déjà vérifiées). */
function checkSchema2Rules(state, errors) {
  const tasks = isArray(state.tasks) ? state.tasks.filter(isObject) : [];
  const gate = (name) => state.gates[name].status;

  // R1 : un plan validé est un plan vérifié par check-plan, et pas modifié depuis.
  if (state.track !== 'quick' && CLEARED.includes(gate('plan'))) {
    const pc = state.planCheck;
    if (!isObject(pc) || pc.status !== 'passed' || pc.by !== 'check-plan') {
      errors.push(`gates.plan validée exige planCheck « passed » posé par check-plan (scripts/check-plan.mjs --record) ; actuel : ${isObject(pc) ? `${pc.status} par ${pc.by}` : 'absent'}`);
    } else if (pc.digest !== planDigest(tasks)) {
      errors.push('planCheck.digest ne correspond plus aux tâches : le plan a changé depuis sa vérification — relance check-plan --record (et fais revalider le plan si besoin)');
    }
  }

  // R2 : une tâche terminée a son périmètre vérifié par check-scope ; écart justifié,
  // fichier sensible approuvé par l'utilisateur.
  if (state.track !== 'quick') {
    for (const task of tasks.filter((t) => t.status === 'done')) {
      const where = `tâche ${task.id}`;
      const scope = task.scope;
      if (!isObject(scope) || scope.by !== 'check-scope') {
        errors.push(`${where} : « done » exige scope posé par check-scope (scripts/check-scope.mjs --task ${task.id})`);
        continue;
      }
      if ((scope.status === 'deviation' || (isArray(scope.outOfPlan) && scope.outOfPlan.length)) && !isString(scope.justification)) {
        errors.push(`${where} : scope « deviation » exige une justification (fichiers hors plan : ${(scope.outOfPlan || []).join(', ')})`);
      }
      if ((scope.status === 'sensitive' || (isArray(scope.sensitive) && scope.sensitive.length)) && scope.approvedBy !== 'user') {
        errors.push(`${where} : scope « sensitive » exige approvedBy « user » (accord explicite de l'utilisateur)`);
      }
    }
  }

  // R3 : la piste quick ne touche jamais une zone sensible.
  if (state.track === 'quick' && isObject(state.scope) && isArray(state.scope.sensitive) && state.scope.sensitive.length) {
    const paths = state.scope.sensitive.map((s) => (isObject(s) ? s.path : s)).join(', ');
    errors.push(`piste quick : fichiers sensibles modifiés (${paths}) — passe en piste standard ou full`);
  }

  // R4 : attente de CI après la livraison ; jamais done avec une CI en échec.
  if (state.status === 'awaiting_ci') {
    if (gate('delivery') !== 'passed') errors.push(`status « awaiting_ci » exige gates.delivery « passed » ; actuel : ${gate('delivery')}`);
    if (!isObject(state.ci)) errors.push('status « awaiting_ci » exige l\'objet « ci »');
  }
  if (state.status === 'done' && isObject(state.ci) && state.ci.status === 'failed') {
    errors.push('status « done » impossible avec ci.status « failed » : corrige la CI ou passe le run en blocked');
  }
}

/** @param team contenu de .claude/team.json (facultatif). */
export function checkState(state, team = null) {
  const errors = [];
  if (!state || typeof state !== 'object' || isArray(state)) return ['state.json doit être un objet JSON'];
  if (!isString(state.id)) errors.push('id : obligatoire');
  oneOf(errors, 'track', state.track, TRACKS);
  oneOf(errors, 'status', state.status, RUN_STATUSES);
  if (state.autonomy !== undefined) oneOf(errors, 'autonomy', state.autonomy, AUTONOMY);
  if (state.issue !== undefined && state.issue !== null && !(Number.isInteger(state.issue) && state.issue > 0)) {
    errors.push(`issue : doit être un entier > 0 (numéro de l'issue GitHub), pas « ${state.issue} »`);
  }
  if (!isArray(state.log)) errors.push('log : doit être une liste');
  if (state.schemaVersion !== undefined && !(Number.isInteger(state.schemaVersion) && state.schemaVersion >= 1)) {
    errors.push(`schemaVersion : entier ≥ 1 attendu (actuel : ${state.schemaVersion})`);
  }
  const v2 = schemaVersion(state) >= 2;
  checkTasks(state, errors);
  checkChecks(state, errors);
  if (v2) checkSchema2Fields(state, errors);
  if (checkGates(state, errors)) {
    checkRules(state, errors, team);
    if (v2) checkSchema2Rules(state, errors);
  }
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
