import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkState } from '../template/.claude/skills/team/scripts/check-state.mjs';
import { TEMPLATE_CLAUDE } from './helpers.mjs';

const EXAMPLE = join(TEMPLATE_CLAUDE, 'skills/team/templates/state.json');
const SCRIPT = join(TEMPLATE_CLAUDE, 'skills/team/scripts/check-state.mjs');
const example = () => JSON.parse(readFileSync(EXAMPLE, 'utf8'));
const errorsOf = (state) => checkState(state).join('\n');

test('le modèle de state.json est valide', () => {
  assert.deepEqual(checkState(example()), []);
});

test('porte 1 : exécution impossible sans plan validé', () => {
  const state = example();
  state.status = 'ready_for_execution';
  assert.match(errorsOf(state), /exige gates\.plan validée \(porte 1\)/);

  state.gates.plan = { status: 'passed', by: 'user', at: '2026-10-18T10:30:00Z', notes: '' };
  assert.match(errorsOf(state), /la tâche T1 est encore « draft »/);

  state.tasks[0].status = 'ready';
  assert.deepEqual(checkState(state), []);

  state.tasks = [];
  assert.match(errorsOf(state), /exige au moins une tâche/);
});

test('portes plan et livraison, et dérogations : réservées à l\'utilisateur', () => {
  const state = example();
  state.tasks[0].status = 'ready';
  state.status = 'executing';
  state.gates.plan = { status: 'passed', by: 'orchestrator', at: null, notes: '' };
  assert.match(errorsOf(state), /gates\.plan : « passed » ne peut être décidé que par l'utilisateur/);

  state.gates.plan = { status: 'waived', by: 'orchestrator', at: null, notes: 'urgent' };
  assert.match(errorsOf(state), /gates\.plan : « waived » ne peut être décidé que par l'utilisateur/);

  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.gates.review = { status: 'waived', by: 'code-reviewer', at: null, notes: 'rien à relire' };
  assert.match(errorsOf(state), /gates\.review : « waived » ne peut être décidé que par l'utilisateur/);
});

test('porte 2 : impossible de la valider sans aucun contrôle', () => {
  const state = example();
  state.checks = [];
  state.gates.checks = { status: 'passed', by: 'run-checks', at: null, notes: '' };
  assert.match(errorsOf(state), /gates\.checks « passed » sans aucun contrôle/);
});

test('porte 2 : chaque contrôle obligatoire de team.json doit figurer dans le run', () => {
  const state = example();
  const team = { checks: [
    { name: 'tests', command: 'pytest', required: true },
    { name: 'lint', command: 'ruff check .', required: true },
    { name: 'docs', command: 'mkdocs build', required: false },
  ] };
  const errors = checkState(state, team).join('\n');
  assert.match(errors, /contrôle obligatoire « lint » de team\.json est absent du run/);
  assert.doesNotMatch(errors, /« tests »|« docs »/);
});

test('attente de livraison : contrôles et relecture validés d\'abord', () => {
  const state = example();
  state.tasks[0].status = 'in_review';
  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.status = 'awaiting_delivery_approval';
  const errors = errorsOf(state);
  assert.match(errors, /« awaiting_delivery_approval » exige gates\.checks validée/);
  assert.match(errors, /« awaiting_delivery_approval » exige gates\.review validée/);
});

test('done (hors quick) exige toutes les tâches terminées', () => {
  const state = example();
  state.tasks[0].status = 'ready';
  state.checks[0].status = 'passed';
  state.status = 'done';
  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.gates.checks = { status: 'passed', by: 'run-checks', at: null, notes: '' };
  state.gates.review = { status: 'passed', by: 'code-reviewer', at: null, notes: '' };
  assert.match(errorsOf(state), /« done » : la tâche T1 est « ready »/);

  state.tasks[0].status = 'done';
  state.tasks[0].validation.checks = 'passed';
  state.tasks[0].validation.review = 'approve';
  assert.deepEqual(checkState(state), []);
});

test('un bloc de tâches recopié tel quel depuis plan.md est valide', () => {
  const plan = readFileSync(join(TEMPLATE_CLAUDE, 'skills/team/templates/plan.md'), 'utf8');
  const block = JSON.parse(plan.match(/```json\n([\s\S]*?)```/)[1]);
  const state = example();
  state.tasks = block;
  assert.deepEqual(checkState(state), []);
});

test('porte 1 : la piste quick n\'a pas de plan à valider', () => {
  const state = example();
  state.track = 'quick';
  state.status = 'checking';
  state.branch = 'team/2026-10-18-exemple';
  assert.deepEqual(checkState(state), []);
});

test('une porte validée doit dire par qui ; une dérogation doit être justifiée', () => {
  const state = example();
  state.gates.plan = { status: 'passed', by: null, at: null, notes: '' };
  state.gates.checks = { status: 'waived', by: 'user', at: null, notes: '' };
  const errors = errorsOf(state);
  assert.match(errors, /gates\.plan : « passed » exige « by »/);
  assert.match(errors, /gates\.checks : « waived » exige une justification/);
});

test('porte 2 : impossible de la valider avec un contrôle obligatoire non exécuté', () => {
  const state = example();
  state.gates.checks = { status: 'passed', by: 'run-checks', at: null, notes: '' };
  assert.match(errorsOf(state), /contrôle obligatoire « tests » est not_run/);

  state.checks[0].status = 'passed';
  assert.deepEqual(checkState(state), []);
});

test('done exige contrôles et relecture validés ; livraison aussi', () => {
  const state = example();
  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.status = 'done';
  state.gates.delivery = { status: 'passed', by: 'user', at: null, notes: '' };
  const errors = errorsOf(state);
  assert.match(errors, /« done » exige gates\.checks validée/);
  assert.match(errors, /« done » exige gates\.review validée/);
  assert.match(errors, /gates\.delivery « passed » exige gates\.checks validée/);
});

test('tâche done sans contrôle réussi : erreur', () => {
  const state = example();
  state.tasks[0].status = 'done';
  assert.match(errorsOf(state), /« done » exige validation\.checks à passed ou n\/a/);
});

test('dépendances : tâche inconnue et cycle', () => {
  const state = example();
  const t2 = { ...structuredClone(state.tasks[0]), id: 'T2', dependsOn: ['T1'] };
  state.tasks.push(t2);
  state.tasks[0].dependsOn = ['T2'];
  assert.match(errorsOf(state), /cycle de dépendances/);

  state.tasks[0].dependsOn = ['T9'];
  assert.match(errorsOf(state), /tâche inconnue « T9 »/);
});

test('valeurs hors liste : statut, type, priorité, statut de contrôle', () => {
  const state = example();
  state.status = 'en_cours';
  state.tasks[0].type = 'chore';
  state.tasks[0].priority = 'haute';
  state.checks[0].status = 'ok';
  const errors = errorsOf(state);
  for (const fragment of ['status : « en_cours »', 'type : « chore »', 'priority : « haute »', 'status : « ok »']) {
    assert.ok(errors.includes(fragment), `attendu : ${fragment}\n${errors}`);
  }
});

test('blocked exige une raison ; awaiting_input exige une question', () => {
  const state = example();
  state.status = 'blocked';
  assert.match(errorsOf(state), /exige « blockedReason »/);
  state.status = 'awaiting_input';
  assert.match(errorsOf(state), /exige au moins une entrée dans « openQuestions »/);
});

test('ligne de commande : 0 sur le modèle, 1 sur un fichier invalide', () => {
  assert.match(execFileSync(process.execPath, [SCRIPT, EXAMPLE], { encoding: 'utf8' }), /OK/);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, SCRIPT], { stdio: 'pipe' }), (err) => err.status === 1);
});

// --- Exécution et autonomie ---

const approvedPlan = (state) => {
  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.tasks[0].status = 'ready';
  return state;
};

test('autonomie : valeur hors liste refusée', () => {
  const state = example();
  state.autonomy = 'total';
  assert.match(errorsOf(state), /autonomy : « total »/);
});

test('porte 1 par l\'orchestrateur : seulement en autonomie, hors piste full, sans tâche requiresHuman', () => {
  const state = example();
  state.gates.plan = { status: 'passed', by: 'orchestrator', at: null, notes: 'autonomie' };
  assert.match(errorsOf(state), /gates\.plan : « passed » ne peut être décidé que par l'utilisateur/);

  state.autonomy = 'autonomous';
  assert.deepEqual(checkState(state), []);

  state.tasks[0].requiresHuman = true;
  assert.match(errorsOf(state), /tâche requiresHuman \(T1\)/);

  state.tasks[0].requiresHuman = false;
  state.track = 'full';
  assert.match(errorsOf(state), /piste full/);

  // La livraison reste humaine, même en autonomie.
  state.track = 'standard';
  state.gates.delivery = { status: 'passed', by: 'orchestrator', at: null, notes: '' };
  assert.match(errorsOf(state), /gates\.delivery : « passed » ne peut être décidé que par l'utilisateur/);
});

test('porte 2 : « passed » seulement posé par run-checks', () => {
  const state = example();
  state.checks[0].status = 'passed';
  state.gates.checks = { status: 'passed', by: 'orchestrator', at: null, notes: '' };
  assert.match(errorsOf(state), /gates\.checks « passed » exige by « run-checks »/);
});

test('tâche done : exige aussi une relecture approuvée', () => {
  const state = example();
  state.tasks[0].status = 'done';
  state.tasks[0].validation = { checks: 'passed', review: 'changes_requested', evidence: [] };
  assert.match(errorsOf(state), /« done » exige validation\.review à approve/);
  state.tasks[0].validation.review = 'approve';
  assert.deepEqual(checkState(state), []);
});

test('porte 3 (hors quick) : validée seulement quand toutes les tâches sont done', () => {
  const state = example();
  state.gates.review = { status: 'passed', by: 'orchestrator', at: null, notes: '' };
  assert.match(errorsOf(state), /gates\.review « passed » exige toutes les tâches à done \(T1 : draft\)/);
});

test('tentatives : au-delà de limits.maxAttempts, la tâche doit être bloquée ou en échec', () => {
  const state = example();
  state.tasks[0].status = 'in_progress';
  state.tasks[0].attempts = 3;
  assert.match(errorsOf(state), /T1.*3 tentatives > maxAttempts \(2\)/);
  state.tasks[0].status = 'failed';
  assert.deepEqual(checkState(state), []);
});

test('exécution : exige une branche de travail distincte de la branche de base', () => {
  const state = approvedPlan(example());
  state.status = 'executing';
  assert.match(errorsOf(state), /« executing » exige « branch »/);
  state.branch = 'main';
  assert.match(errorsOf(state), /branch « main » est la branche de base/);
  state.branch = 'team/2026-10-18-exemple';
  assert.deepEqual(checkState(state), []);
});
