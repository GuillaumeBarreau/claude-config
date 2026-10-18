import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkState, planDigest, RUN_STATUSES } from '../template/.claude/skills/team/scripts/check-state.mjs';
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
  recordPlanCheck(state);
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
  state.tasks[0].scope = okScope();
  recordPlanCheck(state);
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
  return recordPlanCheck(state);
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
  recordPlanCheck(state);
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
  state.tasks[0].scope = okScope();
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

// --- Schéma 2 : vérifications déterministes (plan, périmètre, CI) ---

/** Run v2 au plan validé par l'utilisateur, en exécution, sans vérification de plan. */
function v2Executing() {
  const state = example();
  state.schemaVersion = 2;
  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.tasks[0].status = 'ready';
  state.status = 'executing';
  state.branch = 'team/2026-10-18-exemple';
  return state;
}
/** planCheck tel que l'écrit check-plan --record sur un plan conforme. */
function recordPlanCheck(state) {
  state.planCheck = { status: 'passed', at: null, by: 'check-plan', digest: planDigest(state.tasks), errors: [] };
  return state;
}
/** scope tel que l'écrit check-scope quand la tâche reste dans son plan. */
function okScope() {
  return {
    status: 'ok', changed: ['src/exemple.py'], outOfPlan: [], outOfPlanTests: [], sensitive: [],
    at: null, by: 'check-scope', justification: '', approvedBy: null,
  };
}
/** Run v2 terminé (piste standard), contrôles et relecture validés. */
function v2Done() {
  const state = recordPlanCheck(v2Executing());
  state.status = 'done';
  state.checks[0].status = 'passed';
  state.gates.checks = { status: 'passed', by: 'run-checks', at: null, notes: '' };
  state.gates.review = { status: 'passed', by: 'orchestrator', at: null, notes: '' };
  Object.assign(state.tasks[0], { status: 'done', validation: { checks: 'passed', review: 'approve', evidence: [] }, scope: okScope() });
  return state;
}

test('schéma 2 : le modèle de state.json est en version 2 avec les nouveaux champs', () => {
  const state = example();
  assert.equal(state.schemaVersion, 2);
  for (const key of ['planCheck', 'scope', 'ci', 'pr', 'prComments']) assert.ok(key in state, key);
  for (const key of ['newFiles', 'origin', 'consultations', 'scope']) assert.ok(key in state.tasks[0], key);
  assert.ok(RUN_STATUSES.includes('awaiting_ci'));
});

test('planDigest : tâches du plan seulement, ordre indifférent, newFiles par défaut', () => {
  const state = example();
  const t1 = state.tasks[0];
  const t2 = { ...structuredClone(t1), id: 'T2', newFiles: [] };
  delete t1.newFiles;
  const base = planDigest([t1, t2]);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(planDigest([t2, t1]), base);
  assert.equal(planDigest([t1, t2, { ...structuredClone(t1), id: 'CI1', origin: 'ci', files: [] }]), base);
  assert.equal(planDigest([{ ...t1, title: 'autre titre', status: 'done' }, t2]), base);
  assert.notEqual(planDigest([{ ...t1, files: ['src/autre.py'] }, t2]), base);
  assert.notEqual(planDigest([t1, { ...t2, id: 'T2.1', origin: 'split', splitFrom: 'T2' }]), base);
});

test('R1 : porte plan validée exige planCheck réussi et à jour (schéma 2 seulement)', () => {
  const state = v2Executing();
  assert.match(errorsOf(state), /planCheck/);
  recordPlanCheck(state);
  assert.deepEqual(checkState(state), []);

  state.tasks[0].files = ['src/autre.py'];
  assert.match(errorsOf(state), /planCheck\.digest.*check-plan/);

  recordPlanCheck(state).planCheck.status = 'failed';
  assert.match(errorsOf(state), /planCheck/);

  const v1 = v2Executing();
  delete v1.schemaVersion;
  assert.deepEqual(checkState(v1), []);
});

test('R2 : tâche done sans périmètre vérifié refusée en v2, acceptée en v1', () => {
  const state = v2Done();
  assert.deepEqual(checkState(state), []);
  delete state.tasks[0].scope;
  assert.match(errorsOf(state), /T1.*« done » exige scope posé par check-scope/);
  delete state.schemaVersion;
  assert.deepEqual(checkState(state), []);
});

test('R2 : écart justifié, fichier sensible approuvé par l\'utilisateur', () => {
  const state = v2Done();
  Object.assign(state.tasks[0].scope, { status: 'deviation', outOfPlan: ['src/b.py'] });
  assert.match(errorsOf(state), /scope « deviation » exige une justification/);
  state.tasks[0].scope.justification = 'Fonction utilitaire déplacée';
  assert.deepEqual(checkState(state), []);

  Object.assign(state.tasks[0].scope, { status: 'sensitive', sensitive: [{ path: 'package.json', category: 'dependencies' }] });
  assert.match(errorsOf(state), /scope « sensitive » exige approvedBy « user »/);
  state.tasks[0].scope.approvedBy = 'user';
  assert.deepEqual(checkState(state), []);

  state.tasks[0].scope.by = 'orchestrator';
  assert.match(errorsOf(state), /scope posé par check-scope/);
});

test('R3 : la piste quick ne touche aucun fichier sensible', () => {
  const state = example();
  state.schemaVersion = 2;
  state.track = 'quick';
  state.status = 'checking';
  state.branch = 'team/2026-10-18-exemple';
  state.scope = { ...okScope(), status: 'sensitive', sensitive: [{ path: '.github/workflows/ci.yml', category: 'ci' }] };
  assert.match(errorsOf(state), /piste quick.*\.github\/workflows\/ci\.yml/);
  state.scope = okScope();
  assert.deepEqual(checkState(state), []);
});

test('R4 : awaiting_ci après la livraison seulement ; done impossible avec une CI en échec', () => {
  const state = v2Done();
  state.status = 'awaiting_ci';
  const errors = errorsOf(state);
  assert.match(errors, /« awaiting_ci » exige gates\.delivery « passed »/);
  assert.match(errors, /« awaiting_ci » exige l'objet « ci »/);

  state.gates.delivery = { status: 'passed', by: 'user', at: null, notes: '' };
  state.ci = { status: 'pending', sha: 'abc', startedAt: null, checkedAt: null, rounds: 0, runs: [] };
  assert.deepEqual(checkState(state), []);

  state.status = 'done';
  state.ci.status = 'failed';
  assert.match(errorsOf(state), /« done » impossible avec ci\.status « failed »/);
  state.ci.status = 'n/a';
  assert.deepEqual(checkState(state), []);
});

test('R5 : valeurs d\'origin, ci.status, scope.status ; splitFrom ; newFiles', () => {
  const state = example();
  state.schemaVersion = 2;
  state.tasks[0].origin = 'manuel';
  state.tasks[0].newFiles = 'src/a.py';
  state.ci = { status: 'green', rounds: 0, runs: [] };
  state.scope = { ...okScope(), status: 'parfait' };
  const errors = errorsOf(state);
  for (const fragment of ['origin : « manuel »', 'ci.status : « green »', 'scope.status : « parfait »', 'newFiles : doit être une liste']) {
    assert.ok(errors.includes(fragment), `attendu : ${fragment}\n${errors}`);
  }
  const split = example();
  split.schemaVersion = 2;
  split.tasks[0].origin = 'split';
  assert.match(errorsOf(split), /origin « split » exige « splitFrom »/);
  split.tasks[0].splitFrom = 'T0';
  assert.deepEqual(checkState(split), []);

  const v1 = example();
  delete v1.schemaVersion;
  v1.tasks[0].origin = 'manuel';
  assert.deepEqual(checkState(v1), []);
});
