#!/usr/bin/env node
// Livrable structuré d'un agent de l'équipe : le dernier bloc ```json de son message
// final, sans rien après. Schémas : ../deliverables.md. Le hook SubagentStop
// check-deliverable s'en sert pour refuser un livrable mal formé ; ce CLI est le repli
// quand le hook ne s'est pas déclenché.
//
// Usage : node deliverable.mjs <fichier> --agent <type>   (types : AGENTS ci-dessous)
// Sortie : 0 livrable valide, 1 invalide (erreurs sur stderr), 2 usage ou lecture.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Développeurs : réalisent une tâche du plan (task.agent), même livrable que l'implementer,
// mêmes interdits (guard-files). Source unique des noms d'agents de l'équipe.
export const DEVELOPERS = ['implementer', 'implementer-backend', 'implementer-frontend', 'documentation'];
export const AGENTS = ['planner', ...DEVELOPERS, 'code-reviewer'];
const STATUSES = ['ready', 'blocked', 'needs_input'];
const QUESTION_KINDS = ['technical', 'product'];
const PLANNER_MODES = ['spec', 'plan', 'spec+plan', 'consult', 'split'];
const ACCEPTANCE = ['covered', 'not_covered', 'not_verifiable'];
const VERDICTS = ['approve', 'changes_requested', 'blocked'];
const SEVERITIES = ['critical', 'major', 'minor'];
const CONFIDENCES = ['confirmed', 'plausible'];
const SOURCES = ['review', 'pr-comment', 'ci'];

export const SCHEMA_HINT = 'Termine ton message par un bloc ```json conforme à .claude/skills/team/deliverables.md, '
  + 'sans aucun texte après (champs communs : agent, run, status, questions).';

/** Dernier bloc ```json du texte ; il doit être suivi uniquement d'espaces. */
export function extractDeliverable(text) {
  const fail = (error) => ({ data: null, error });
  const blocks = [...String(text ?? '').matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)];
  const last = blocks.at(-1);
  if (!last) return fail('aucun bloc ```json dans le message final');
  if (String(text).slice(last.index + last[0].length).trim()) {
    return fail('du texte suit le dernier bloc ```json : le bloc doit terminer le message (rien après le bloc)');
  }
  let data;
  try {
    data = JSON.parse(last[1]);
  } catch (err) {
    return fail(`JSON invalide dans le dernier bloc : ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('le bloc doit contenir un objet JSON');
  return { data, error: null };
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Vérifie une liste d'objets ; `check(item, where)` ajoute ses erreurs. */
function list(errors, obj, key, check, { required = true } = {}) {
  const value = obj[key];
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    errors.push(`${key} : doit être une liste`);
    return [];
  }
  value.forEach((item, i) => {
    if (!isObject(item)) errors.push(`${key}[${i}] : doit être un objet`);
    else check(item, `${key}[${i}]`);
  });
  return value;
}

function oneOf(errors, where, value, allowed) {
  if (!allowed.includes(value)) errors.push(`${where} : « ${value} » invalide (${allowed.join(', ')})`);
}

function texts(errors, item, where, keys) {
  for (const key of keys) if (!isText(item[key])) errors.push(`${where}.${key} : texte non vide obligatoire`);
}

const commandList = (errors, obj, key) => list(errors, obj, key, (c, w) => texts(errors, c, w, ['command', 'result']));

function acceptanceList(errors, obj) {
  return list(errors, obj, 'acceptance', (a, w) => {
    if (!/^AC\d+$/.test(a.id ?? '')) errors.push(`${w}.id : « ${a.id} » n'est pas un identifiant ACn`);
    oneOf(errors, `${w}.status`, a.status, ACCEPTANCE);
    if (typeof a.evidence !== 'string') errors.push(`${w}.evidence : texte obligatoire (preuve ou raison)`);
  });
}

export function checkFinding(errors, f, where) {
  texts(errors, f, where, ['id', 'file', 'problem', 'scenario', 'fix']);
  oneOf(errors, `${where}.severity`, f.severity, SEVERITIES);
  oneOf(errors, `${where}.confidence`, f.confidence, CONFIDENCES);
  oneOf(errors, `${where}.source`, f.source, SOURCES);
  if (f.line !== null && !(Number.isInteger(f.line) && f.line > 0)) errors.push(`${where}.line : entier > 0 ou null`);
  if (f.url !== undefined && !isText(f.url)) errors.push(`${where}.url : texte non vide si présent`);
}

function checkPlanner(errors, d) {
  oneOf(errors, 'mode', d.mode, PLANNER_MODES);
  if (d.status !== 'ready') return;
  if (['spec', 'spec+plan'].includes(d.mode)) {
    const ac = d.acceptanceCriteria;
    if (!Array.isArray(ac) || !ac.length || !ac.every((id) => /^AC\d+$/.test(id))) {
      errors.push('acceptanceCriteria : liste non vide d\'identifiants ACn obligatoire en mode spec');
    }
  }
  if (['plan', 'spec+plan'].includes(d.mode) && !(Array.isArray(d.taskIds) && d.taskIds.length && d.taskIds.every(isText))) {
    errors.push('taskIds : liste non vide des identifiants de tâches obligatoire en mode plan');
  }
  if (d.mode === 'consult') {
    if (!isObject(d.answer)) errors.push('answer : objet { decision, rationale, constraints } obligatoire en mode consult');
    else {
      texts(errors, d.answer, 'answer', ['decision', 'rationale']);
      if (!Array.isArray(d.answer.constraints)) errors.push('answer.constraints : doit être une liste');
    }
  }
  if (d.mode === 'split') {
    if (!isText(d.replaces)) errors.push('replaces : identifiant de la tâche redécoupée obligatoire en mode split');
    const tasks = list(errors, d, 'tasks', (t, w) => {
      texts(errors, t, w, ['id', 'title']);
      for (const key of ['acceptanceCriteria', 'dependsOn', 'files']) {
        if (!Array.isArray(t[key])) errors.push(`${w}.${key} : doit être une liste`);
      }
      if (t.newFiles !== undefined && !Array.isArray(t.newFiles)) errors.push(`${w}.newFiles : doit être une liste`);
      if (typeof t.requiresHuman !== 'boolean') errors.push(`${w}.requiresHuman : true ou false`);
    });
    if (Array.isArray(d.tasks) && !tasks.length) errors.push('tasks : au moins une tâche en mode split');
  }
}

function checkImplementer(errors, d) {
  if (!isText(d.task)) errors.push('task : identifiant de la tâche obligatoire');
  const files = list(errors, d, 'files', (f, w) => texts(errors, f, w, ['path', 'change']));
  acceptanceList(errors, d);
  const evidence = commandList(errors, d, 'evidence');
  list(errors, d, 'deviations', (x, w) => texts(errors, x, w, ['path', 'reason']));
  if (d.status === 'ready') {
    if (!files.length) errors.push('files : au moins un fichier modifié quand status vaut ready');
    if (!evidence.length) errors.push('evidence : au moins une commande et son résultat quand status vaut ready');
  }
}

function checkReviewer(errors, d) {
  if (d.task !== null && !isText(d.task)) errors.push('task : identifiant de la tâche, ou null hors tâche');
  oneOf(errors, 'verdict', d.verdict, VERDICTS);
  const findings = list(errors, d, 'findings', (f, w) => checkFinding(errors, f, w));
  acceptanceList(errors, d);
  commandList(errors, d, 'checks');
  const serious = findings.filter((f) => isObject(f) && ['critical', 'major'].includes(f.severity) && f.confidence === 'confirmed');
  if (d.verdict === 'approve' && serious.length) {
    errors.push(`verdict approve incompatible avec ${serious.length} constat(s) critical/major confirmé(s) : changes_requested`);
  }
  if (d.verdict === 'changes_requested' && !serious.length) {
    errors.push('verdict changes_requested sans constat critical/major confirmé : approve, ou confirme le constat');
  }
}

/** Erreurs du livrable `d` pour l'agent `agentType` ([] = valide). */
export function validateDeliverable(d, agentType) {
  if (!isObject(d)) return ['le livrable doit être un objet JSON'];
  if (!AGENTS.includes(agentType)) return [`agent « ${agentType} » sans schéma de livrable (${AGENTS.join(', ')})`];
  const errors = [];
  if (d.agent !== agentType) errors.push(`agent : « ${d.agent} » attendu « ${agentType} »`);
  if (d.run !== null && !(isText(d.run) && /^[\w.-]+$/.test(d.run))) errors.push('run : identifiant du run, ou null hors run');
  oneOf(errors, 'status', d.status, STATUSES);
  const questions = list(errors, d, 'questions', (q, w) => {
    oneOf(errors, `${w}.kind`, q.kind, QUESTION_KINDS);
    texts(errors, q, w, ['text']);
  });
  if (d.status === 'needs_input' && !questions.length) errors.push('questions : au moins une question quand status vaut needs_input');
  if (agentType === 'planner') checkPlanner(errors, d);
  if (DEVELOPERS.includes(agentType)) checkImplementer(errors, d);
  if (agentType === 'code-reviewer') checkReviewer(errors, d);
  return errors;
}

function main(argv) {
  const file = argv[2];
  const agentAt = argv.indexOf('--agent');
  const agent = agentAt > -1 ? argv[agentAt + 1] : undefined;
  if (!file || file.startsWith('--') || !agent) {
    console.error(`usage : node deliverable.mjs <fichier> --agent <${AGENTS.join('|')}>`);
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`${file} : illisible (${err.message})`);
    return 2;
  }
  const { data, error } = extractDeliverable(text);
  const errors = error ? [error] : validateDeliverable(data, agent);
  if (!errors.length) {
    console.log(`${file} : livrable ${agent} valide`);
    return 0;
  }
  for (const e of errors) console.error(`erreur : ${e}`);
  console.error(SCHEMA_HINT);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
