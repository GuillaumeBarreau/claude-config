import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkPlan } from '../template/.claude/skills/team/scripts/check-plan.mjs';
import { checkState } from '../template/.claude/skills/team/scripts/check-state.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

const RUN = '2026-10-18-exemple';
const SPEC = `# Spécification — x

## Objectif

Ajouter une option.

## Critères d'acceptation

- **AC1** — Étant donné un fichier, quand on lance list, alors il s'affiche.
- **AC2** — Étant donné --json, quand on lance list, alors la sortie est du JSON.

## Hors périmètre

- AC9 n'est pas un critère : cette section ne compte pas.
`;

function task(id, extra = {}) {
  return {
    id, title: `Tâche ${id}`, description: 'Ce que la tâche produit.', type: 'feature', priority: 'P1', complexity: 'S',
    acceptanceCriteria: ['AC1'], dependsOn: [], files: ['src/cli.js'], newFiles: [], origin: 'plan', agent: 'implementer',
    tests: ['cas nominal'], risks: [], requiresHuman: false, status: 'draft', attempts: 0, consultations: 0,
    validation: { checks: 'not_run', review: null, evidence: [] }, ...extra,
  };
}
const planMd = (tasks) => `# Plan technique — x

## Tâches

| Id | Titre |
| -- | ----- |

## Bloc des tâches

Exemple ancien, ignoré : seul le dernier bloc compte.

\`\`\`json
[]
\`\`\`

\`\`\`json
${JSON.stringify(tasks, null, 2)}
\`\`\`
`;

/** Projet installé, run en attente de validation du plan, plan.md et state.json identiques. */
function setup({ tasks = [task('T1'), task('T2', { acceptanceCriteria: ['AC2'], dependsOn: ['T1'], files: ['src/cli.js'], newFiles: ['test/cli.test.js'] })],
  stateTasks = tasks, spec = SPEC, track = 'standard' } = {}) {
  const root = templateCopy();
  writeFile(join(root, 'src/cli.js'), 'console.log(1);\n');
  writeFile(join(root, 'package.json'), '{}\n');
  const state = JSON.parse(readFileSync(join(root, '.claude/skills/team/templates/state.json'), 'utf8'));
  state.track = track;
  state.tasks = structuredClone(stateTasks);
  const runDir = join(root, '.agent-runs', RUN);
  writeFile(join(runDir, 'spec.md'), spec);
  writeFile(join(runDir, 'plan.md'), planMd(tasks));
  writeFile(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  const read = () => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  return { root, runDir, read };
}
const errorsFor = (opts) => {
  const { root, runDir } = setup(opts);
  return checkPlan(runDir, { projectDir: root }).errors.join('\n');
};

test('check-plan : un plan cohérent passe', () => {
  const { root, runDir } = setup();
  const result = checkPlan(runDir, { projectDir: root });
  assert.deepEqual(result.errors, []);
  assert.equal(result.status, 'passed');
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test('check-plan : critères d\'acceptation non couverts ou inconnus', () => {
  assert.match(errorsFor({ tasks: [task('T1')] }), /AC2 n'est couvert par aucune tâche/);
  assert.match(errorsFor({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2', 'AC9'] })] }), /T1 cite AC9, absent de spec\.md/);
  const loose = SPEC.replace(/\*\*(AC\d)\*\*/g, '$1');
  assert.match(errorsFor({ spec: loose, tasks: [task('T1')] }), /AC2 n'est couvert/);
  assert.match(errorsFor({ spec: '# Spec\n\n## Objectif\n\nx\n', tasks: [task('T1')] }), /aucun critère d'acceptation/);
});

test('check-plan : le bloc de plan.md et state.json doivent concorder', () => {
  const tasks = [task('T1', { acceptanceCriteria: ['AC1', 'AC2'] })];
  const drift = [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], files: ['src/cli.js', 'package.json'], requiresHuman: true })];
  assert.match(errorsFor({ tasks, stateTasks: drift }), /T1 : plan\.md et state\.json diffèrent sur files/);
  assert.match(errorsFor({ tasks, stateTasks: [] }), /T1 : présente dans plan\.md, absente de state\.json/);
  const extra = [...tasks, task('T2', { acceptanceCriteria: ['AC1'] })];
  assert.match(errorsFor({ tasks, stateTasks: extra }), /T2 : présente dans state\.json, absente du bloc de plan\.md/);
});

test('check-plan : chemins interdits, fichier absent, nouveau fichier déjà présent', () => {
  for (const [bad, pattern] of [['/etc/passwd', /chemin absolu/], ['C:\\src\\a.js', /chemin absolu/], ['../a.js', /« \.\. »/],
    ['src/…', /« … »/], ['src/<module>.js', /« <…> »/], ['src/*.js', /glob/]]) {
    assert.match(errorsFor({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], files: [bad] })] }), pattern, bad);
  }
  assert.match(errorsFor({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], files: ['src/absent.js'] })] }),
    /src\/absent\.js : absent du disque et absent de newFiles/);

  const { root, runDir } = setup({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], newFiles: ['src/cli.js'], files: [] })] });
  const result = checkPlan(runDir, { projectDir: root });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /src\/cli\.js : déjà présent/);
});

test('check-plan : un fichier créé par une tâche peut être modifié par une suivante', () => {
  const tasks = [task('T1', { acceptanceCriteria: ['AC1'], files: [], newFiles: ['src/new.js'] }),
    task('T2', { acceptanceCriteria: ['AC2'], files: ['src/new.js'], dependsOn: ['T1'] })];
  assert.equal(errorsFor({ tasks }), '');
});

test('check-plan : dépendances, fichier sensible, tâche sans fichier', () => {
  assert.match(errorsFor({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], dependsOn: ['T7'] })] }), /tâche inconnue « T7 »/);
  assert.match(errorsFor({ tasks: [task('T1', { dependsOn: ['T2'] }), task('T2', { acceptanceCriteria: ['AC2'], dependsOn: ['T1'] })] }),
    /cycle de dépendances/);
  assert.match(errorsFor({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], files: ['package.json'] })] }),
    /T1 : package\.json est sensible \(dependencies\) mais requiresHuman vaut false/);
  assert.equal(errorsFor({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], files: ['package.json'], requiresHuman: true })] }), '');
  assert.match(errorsFor({ tasks: [task('T1', { acceptanceCriteria: ['AC1', 'AC2'], files: [] })] }), /T1 : aucune entrée dans files ni newFiles/);
});

test('check-plan : tâches ci et pr-review sans fichiers, tâches redécoupées', () => {
  const t1 = task('T1', { acceptanceCriteria: ['AC1', 'AC2'] });
  const ci = task('CI1', { origin: 'ci', files: [], acceptanceCriteria: [] });
  assert.equal(errorsFor({ tasks: [t1], stateTasks: [t1, ci] }), '');

  const t2 = task('T2', { acceptanceCriteria: ['AC2'] });
  const splits = [task('T2.1', { origin: 'split', splitFrom: 'T2', acceptanceCriteria: ['AC2'] }),
    task('T2.2', { origin: 'split', splitFrom: 'T2', acceptanceCriteria: [], dependsOn: ['T2.1'] })];
  assert.equal(errorsFor({ tasks: [task('T1'), t2], stateTasks: [task('T1'), ...splits] }), '');
});

test('check-plan : piste quick sans objet', () => {
  const { root, runDir } = setup({ track: 'quick', tasks: [] });
  assert.equal(checkPlan(runDir, { projectDir: root }).status, 'n/a');
});

const cli = (root, ...args) => spawnSync(process.execPath, [join(root, '.claude/skills/team/scripts/check-plan.mjs'), ...args],
  { encoding: 'utf8', cwd: root });

test('check-plan (CLI) : --record accepté par checkState, puis modifier files fait échouer R1', () => {
  const { root, runDir, read } = setup();
  const res = cli(root, `.agent-runs/${RUN}`, '--record');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const state = read();
  assert.equal(state.planCheck.status, 'passed');
  assert.equal(state.planCheck.by, 'check-plan');
  assert.equal(state.log.at(-1).event, 'plan_checked');

  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.tasks.forEach((t) => { t.status = 'ready'; });
  state.status = 'ready_for_execution';
  assert.deepEqual(checkState(state), []);
  state.tasks[0].files.push('src/autre.js');
  assert.match(checkState(state).join('\n'), /planCheck\.digest/);
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
});

test('check-plan (CLI) : 1 sur un plan en erreur (enregistré failed), 2 sur un usage invalide', () => {
  const { root, read } = setup({ tasks: [task('T1')] });
  const res = cli(root, `.agent-runs/${RUN}`, '--record');
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /AC2/);
  assert.equal(read().planCheck.status, 'failed');
  assert.ok(read().planCheck.errors.length > 0);

  assert.equal(cli(root).status, 2);
  assert.equal(cli(root, '.agent-runs/inconnu').status, 2);
  const quick = setup({ track: 'quick', tasks: [] });
  assert.equal(cli(quick.root, `.agent-runs/${RUN}`).status, 0);
});
