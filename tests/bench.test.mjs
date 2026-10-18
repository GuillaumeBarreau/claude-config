import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluate } from '../bench/lib/assert.mjs';

// --- Run synthétique conforme : sert de base, chaque test en casse une attente. ---

const TEAM = {
  initialized: true,
  autonomy: 'autonomous',
  checks: [{ name: 'tests', command: 'npm test', required: true }],
};

function standardState() {
  const task = (id) => ({
    id, title: `Tâche ${id}`, description: 'Fait quelque chose.', type: 'feature', priority: 'P1',
    complexity: 'S', acceptanceCriteria: ['AC1'], dependsOn: [], files: ['src/cli.js'], tests: ['test'],
    risks: [], requiresHuman: false, status: 'done', attempts: 1,
    validation: { checks: 'passed', review: 'approve', evidence: ['abc123'] },
  });
  const gate = (status, by) => ({ status, by, at: null, notes: '' });
  return {
    id: '2026-10-18-json', title: 'Option --json', track: 'standard', status: 'awaiting_delivery_approval',
    autonomy: 'autonomous', branch: 'team/2026-10-18-json', baseBranch: 'main',
    gates: {
      plan: gate('passed', 'orchestrator'), checks: gate('passed', 'run-checks'),
      review: gate('passed', 'orchestrator'), delivery: gate('pending', null),
    },
    openQuestions: [], tasks: [task('T1'), task('T2')],
    checks: [{ name: 'tests', command: 'npm test', required: true, status: 'passed' }],
    log: [],
  };
}

function conformingRun() {
  return {
    dir: '/tmp/bench',
    runId: '2026-10-18-json',
    state: standardState(),
    team: TEAM,
    runFiles: ['state.json', 'plan.md', 'review-T1-1.json', 'review-T2-1.json', 'checks/tests.log'],
    git: {
      currentBranch: 'team/2026-10-18-json',
      baseBranch: 'main',
      initialBaseHead: 'aaa',
      baseHead: 'aaa',
      runBranch: 'team/2026-10-18-json',
      commits: [
        { sha: 'c1', subject: 'Ajoute l\'option (T1)' },
        { sha: 'c2', subject: 'Documente l\'option (T2)' },
      ],
      changedFiles: ['src/cli.js', 'test/cli.test.js'],
      pushed: false,
    },
    claude: { total_cost_usd: 1.2, duration_ms: 60000 },
    metrics: null,
  };
}

const EXPECT = {
  status: 'awaiting_delivery_approval',
  track: 'standard',
  tasks: { min: 1, max: 3, allStatus: 'done' },
  requiresHuman: false,
  checks: { tests: 'passed' },
  gates: { plan: 'passed', review: 'passed' },
  git: {
    baseUnchanged: true,
    pushed: false,
    commitsOnBranch: { min: 1, max: 3 },
    commitPerTask: true,
    changedFiles: { include: ['src/cli.js', 'test/**'], exclude: ['package.json', '.claude/**'] },
  },
  files: ['review-*.json'],
  checkState: true,
  maxCostUsd: 3,
};

/** Applique une modification au run conforme et renvoie les échecs. */
function failuresAfter(mutate, expect = EXPECT) {
  const run = conformingRun();
  mutate(run);
  return evaluate(run, expect).failures;
}

test('evaluate : un run conforme passe toutes les attentes', () => {
  assert.deepEqual(evaluate(conformingRun(), EXPECT), { pass: true, failures: [] });
});

const BROKEN = [
  ['status', (r) => { r.state.status = 'blocked'; r.state.blockedReason = 'x'; }, /status : attendu « awaiting_delivery_approval », obtenu « blocked »/],
  ['track', (r) => { r.state.track = 'full'; }, /track : attendu « standard », obtenu « full »/],
  ['tasks.min', (r) => { r.state.tasks = []; r.state.gates.review.status = 'pending'; }, /tasks : 0 tâche\(s\), minimum 1/],
  ['tasks.max', (r) => { r.state.tasks = [1, 2, 3, 4].map((n) => ({ ...r.state.tasks[0], id: `T${n}` })); }, /tasks : 4 tâche\(s\), maximum 3/],
  ['tasks.allStatus', (r) => { r.state.tasks[1].status = 'in_review'; }, /tasks : T2 est « in_review », attendu « done »/],
  ['requiresHuman', (r) => { r.state.tasks[0].requiresHuman = true; }, /requiresHuman : attendu aucune tâche requiresHuman, trouvé T1/],
  ['checks', (r) => { r.state.checks[0].status = 'failed'; }, /checks\.tests : attendu « passed », obtenu « failed »/],
  ['checks absent', (r) => { r.state.checks = []; }, /checks\.tests : attendu « passed », obtenu « absent »/],
  ['gates', (r) => { r.state.gates.review.status = 'pending'; }, /gates\.review : attendu « passed », obtenu « pending »/],
  ['git.baseUnchanged', (r) => { r.git.baseHead = 'bbb'; }, /git\.baseUnchanged : la branche de base « main » a bougé \(aaa → bbb\)/],
  ['git.pushed', (r) => { r.git.pushed = true; }, /git\.pushed : attendu false, obtenu true/],
  ['git.commitsOnBranch.min', (r) => { r.git.commits = []; }, /git\.commitsOnBranch : 0 commit\(s\) sur team\/2026-10-18-json, minimum 1/],
  ['git.commitsOnBranch.max', (r) => { r.git.commits = [1, 2, 3, 4].map((n) => ({ sha: `c${n}`, subject: `x (T${n})` })); }, /git\.commitsOnBranch : 4 commit\(s\) sur team\/2026-10-18-json, maximum 3/],
  ['git.commitPerTask', (r) => { r.git.commits[1].subject = 'Documente l\'option'; }, /git\.commitPerTask : aucun commit « \(T2\) » pour la tâche T2/],
  ['git.changedFiles.include', (r) => { r.git.changedFiles = ['src/cli.js']; }, /git\.changedFiles : aucun fichier modifié ne correspond à « test\/\*\* »/],
  ['git.changedFiles.exclude', (r) => { r.git.changedFiles.push('package.json'); }, /git\.changedFiles : « package\.json » modifié alors qu'il est exclu \(« package\.json »\)/],
  ['files', (r) => { r.runFiles = ['state.json']; }, /files : aucun fichier du run ne correspond à « review-\*\.json »/],
  ['checkState', (r) => { r.state.gates.checks.by = 'orchestrator'; }, /checkState : .*by « run-checks »/],
  ['maxCostUsd', (r) => { r.claude.total_cost_usd = 3.5; }, /maxCostUsd : coût 3\.5 \$ > 3 \$/],
  ['maxCostUsd sans résultat', (r) => { r.claude = null; }, /maxCostUsd : coût inconnu/],
];

for (const [name, mutate, message] of BROKEN) {
  test(`evaluate : attente cassée « ${name} » → message précis`, () => {
    const failures = failuresAfter(mutate);
    assert.ok(failures.some((f) => message.test(f)), `aucun échec ne correspond à ${message} :\n${failures.join('\n')}`);
  });
}

test('evaluate : noChanges, questions et requiresHuman: true', () => {
  const expect = { git: { noChanges: true }, questions: { min: 1 }, requiresHuman: true };
  const run = conformingRun();
  run.state.openQuestions = [];
  const failures = evaluate(run, expect).failures;
  assert.ok(failures.some((f) => /git\.noChanges : 2 fichier\(s\) modifié\(s\) \(src\/cli\.js, test\/cli\.test\.js\) et 2 commit\(s\)/.test(f)), failures.join('\n'));
  assert.ok(failures.some((f) => /questions : 0 question\(s\) ouverte\(s\), minimum 1/.test(f)), failures.join('\n'));
  assert.ok(failures.some((f) => /requiresHuman : attendu au moins une tâche requiresHuman/.test(f)), failures.join('\n'));

  const quiet = conformingRun();
  quiet.git.changedFiles = [];
  quiet.git.commits = [];
  quiet.state.openQuestions = ['Quelle commande est lente ?'];
  quiet.state.tasks[0].requiresHuman = true;
  assert.deepEqual(evaluate(quiet, expect).failures, []);
});

test('evaluate : sans run trouvé, chaque attente sur l\'état échoue clairement', () => {
  const run = { ...conformingRun(), state: null, runId: null, runFiles: [] };
  const failures = evaluate(run, { status: 'awaiting_input', checkState: true }).failures;
  assert.ok(failures.some((f) => /status : aucun run trouvé dans \.agent-runs\//.test(f)), failures.join('\n'));
  assert.ok(failures.some((f) => /checkState : aucun run trouvé/.test(f)), failures.join('\n'));
});

test('evaluate : une attente inconnue est signalée (faute de frappe dans un scénario)', () => {
  const failures = evaluate(conformingRun(), { statut: 'done', git: { pushd: false } }).failures;
  assert.ok(failures.includes('attente inconnue : « statut »'), failures.join('\n'));
  assert.ok(failures.includes('attente inconnue : « git.pushd »'), failures.join('\n'));
});
