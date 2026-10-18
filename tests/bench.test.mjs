import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { collectRun, evaluate } from '../bench/lib/assert.mjs';
import { BENCH_ALLOWED_TOOLS, childEnv, claudeArgs, quoteForCmd, resolveClaude, runClaude } from '../bench/lib/claude.mjs';
import { listScenarios, loadScenario, prepare } from '../bench/lib/prepare.mjs';
import { main as bench } from '../bench/run.mjs';
import { validate } from '../validate.mjs';

// Aucun test ne lance le vrai claude : run.mjs reçoit un spawn simulé.

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

// --- collectRun, prepare, claude et run : sur de vrais dépôts temporaires. ---

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const writeIn = (dir, rel, content) => {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
};

/** Ce qu'un vrai /team laisserait dans le projet, en piste quick ou standard. */
function simulateRun(dir, kind) {
  const id = kind === 'quick' ? '2026-10-18-slug' : '2026-10-18-json';
  const branch = `team/${id}`;
  git(dir, 'switch', '-q', '-c', branch);
  const state = standardState();
  Object.assign(state, { id, branch, createdAt: '2026-10-18T10:00:00Z' });
  if (kind === 'quick') {
    Object.assign(state, { track: 'quick', tasks: [] });
    state.gates.plan = { status: 'pending', by: null, at: null, notes: '' };
    writeIn(dir, 'src/slugify.js', readFileSync(join(dir, 'src/slugify.js'), 'utf8').replace('const [first', "if (!words.length) return '';\n  const [first"));
    writeIn(dir, 'test/empty.test.js', "import { test } from 'node:test';\ntest('vide', () => {});\n");
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', "Corrige slugify('')");
    writeIn(dir, `.agent-runs/${id}/review-1.json`, { verdict: 'approve' });
  } else {
    // Champs du schéma 2 (lots A, B, D) : collectRun doit les tolérer.
    state.schemaVersion = 2;
    state.planCheck = { status: 'passed', at: null, by: 'check-plan', digest: 'x', errors: [] };
    state.ci = { status: 'pending', rounds: 0, runs: [] };
    for (const task of state.tasks) {
      task.newFiles = [];
      task.scope = { status: 'ok', changed: ['src/cli.js'], outOfPlan: [], outOfPlanTests: [], sensitive: [], by: 'check-scope' };
      writeIn(dir, 'src/cli.js', `${readFileSync(join(dir, 'src/cli.js'), 'utf8')}// ${task.id}\n`);
      git(dir, 'commit', '-q', '-am', `Option --json (${task.id})`);
      writeIn(dir, `.agent-runs/${id}/review-${task.id}-1.json`, { verdict: 'approve' });
    }
    writeIn(dir, `.agent-runs/${id}/metrics.jsonl`, [
      { at: 'x', kind: 'agent', agent: 'implementer', task: 'T1', model: 'sonnet', durationMs: 1000, toolUses: 3, tokens: 500 },
      { at: 'x', kind: 'agent', agent: 'implementer', task: 'T2', model: 'sonnet', durationMs: 2000, toolUses: 3, tokens: 700 },
      { at: 'x', kind: 'turn' },
      { at: 'x', kind: 'deliverable_rejected', agent: 'planner' },
    ].map((l) => JSON.stringify(l)).join('\n'));
  }
  writeIn(dir, `.agent-runs/${id}/state.json`, state);
  writeIn(dir, '.agent-runs/2020-01-01-ancien/state.json', { ...state, id: '2020-01-01-ancien', createdAt: '2020-01-01T00:00:00Z' });
  return id;
}

test('prepare : dépôt propre sur main, installation valide, team.json du banc', () => {
  const dir = join(tmp('bench-prep-'), 'projet');
  const result = prepare('quick-bug', { dir });
  assert.equal(result.dir, dir);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'branch', '--show-current'), 'main');
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '2');
  assert.deepEqual(validate(dir).errors, []);
  const team = JSON.parse(readFileSync(join(dir, '.claude', 'team.json'), 'utf8'));
  assert.equal(team.initialized, true);
  assert.equal(team.autonomy, 'autonomous');
  assert.deepEqual(team.checks, [{ name: 'tests', command: 'npm test', required: true }]);
  assert.ok(existsSync(join(dir, 'src', 'slugify.js')));
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\.agent-runs\//);
  const meta = JSON.parse(readFileSync(join(dir, '.git', 'claude-bench.json'), 'utf8'));
  assert.equal(meta.scenario, 'quick-bug');
  assert.equal(meta.baseHead, git(dir, 'rev-parse', 'main'));
  // Le projet d'essai part avec des tests verts (le bug n'est pas couvert).
  execFileSync(process.execPath, ['--test'], { cwd: dir, stdio: 'ignore' });
});

test('prepare : refuse un dossier non vide et un scénario inconnu', () => {
  const dir = tmp('bench-prep-');
  writeFileSync(join(dir, 'x.txt'), 'x');
  assert.throws(() => prepare('quick-bug', { dir }), /n'est pas vide/);
  assert.throws(() => prepare('inexistant', { dir: join(dir, 'p') }), /scénario inconnu/);
  assert.throws(() => prepare('../team', { dir: join(dir, 'p') }), /scénario inconnu/);
});

test('collectRun : run le plus récent, git et fichiers du run, champs v2 tolérés', () => {
  const dir = join(tmp('bench-collect-'), 'projet');
  prepare('standard-feature', { dir });
  const base = git(dir, 'rev-parse', 'main');
  simulateRun(dir, 'standard');
  writeIn(dir, '.agent-runs/bench-claude.json', { total_cost_usd: 0.5 });
  const run = collectRun(dir);
  assert.equal(run.runId, '2026-10-18-json');
  assert.equal(run.scenario, 'standard-feature');
  assert.equal(run.state.schemaVersion, 2);
  assert.equal(run.git.baseBranch, 'main');
  assert.equal(run.git.initialBaseHead, base);
  assert.equal(run.git.baseHead, base);
  assert.equal(run.git.runBranch, 'team/2026-10-18-json');
  assert.deepEqual(run.git.commits.map((c) => c.subject), ['Option --json (T2)', 'Option --json (T1)']);
  assert.deepEqual(run.git.changedFiles, ['src/cli.js']);
  assert.equal(run.git.pushed, false);
  assert.ok(run.runFiles.includes('review-T1-1.json'));
  assert.equal(run.claude.total_cost_usd, 0.5);
  assert.deepEqual(run.metrics.agents.implementer, { calls: 2, durationMs: 3000, tokens: 1200 });
  assert.equal(run.metrics.turns, 1);
  assert.equal(run.metrics.rejected, 1);
  assert.equal(run.team.initialized, true);

  // Fichier non suivi et base déplacée : vus.
  writeIn(dir, 'notes.txt', 'x');
  git(dir, 'switch', '-q', 'main');
  writeIn(dir, 'README.md', 'x');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'sur la base');
  const after = collectRun(dir);
  assert.notEqual(after.git.baseHead, base);
  assert.ok(after.git.changedFiles.includes('notes.txt'));
  assert.ok(after.git.changedFiles.includes('README.md'));
});

test('collectRun : projet sans run ni résultat claude', () => {
  const dir = join(tmp('bench-collect-'), 'projet');
  prepare('ambiguous', { dir });
  const run = collectRun(dir);
  assert.equal(run.state, null);
  assert.equal(run.claude, null);
  assert.deepEqual(run.git.changedFiles, []);
  assert.deepEqual(run.git.commits, []);
});

// --- claude.mjs ---

test('resolveClaude : sous Windows, .exe avant .cmd ; .cmd lancé via le shell', () => {
  const env = { Path: 'C:\\a;C:\\b' };
  const exeAndCmd = resolveClaude({ platform: 'win32', env, exists: (p) => ['C:\\a\\claude.cmd', 'C:\\b\\claude.exe'].includes(p) });
  assert.deepEqual(exeAndCmd, { command: 'C:\\b\\claude.exe', shell: false });
  const cmdOnly = resolveClaude({ platform: 'win32', env, exists: (p) => p === 'C:\\a\\claude.cmd' });
  assert.deepEqual(cmdOnly, { command: 'C:\\a\\claude.cmd', shell: true });
  assert.throws(() => resolveClaude({ platform: 'win32', env, exists: () => false }), /claude introuvable/);
  assert.deepEqual(resolveClaude({ platform: 'linux', env: { PATH: '/usr/bin' } }), { command: 'claude', shell: false });
});

test('quoteForCmd : guillemets, refus des caractères que cmd.exe interprète même entre guillemets', () => {
  assert.equal(quoteForCmd("/team corrige slugify('') & co"), "\"/team corrige slugify('') & co\"");
  assert.throws(() => quoteForCmd('a "b"'), /cmd\.exe/);
  assert.throws(() => quoteForCmd('100%'), /cmd\.exe/);
  assert.throws(() => quoteForCmd('a\nb'), /cmd\.exe/);
});

test('claudeArgs et childEnv : options du banc, CLAUDECODE retiré', () => {
  const args = claudeArgs({ request: 'corrige le bug', budgetUsd: 2, maxTurns: 50 });
  assert.deepEqual(args.slice(0, 2), ['-p', '/team corrige le bug']);
  for (const [flag, value] of [['--output-format', 'json'], ['--permission-mode', 'acceptEdits'], ['--max-budget-usd', '2'], ['--max-turns', '50']]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  }
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1), BENCH_ALLOWED_TOOLS);
  assert.ok(BENCH_ALLOWED_TOOLS.includes('Agent'));
  const env = childEnv({ CLAUDECODE: '1', PATH: 'x' });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.PATH, 'x');
});

test('claudeArgs : aucun plafond de coût par défaut, seulement si --budget-usd est donné', () => {
  const args = claudeArgs({ request: 'corrige le bug' });
  assert.ok(!args.includes('--max-budget-usd'), 'pas de --max-budget-usd par défaut');
  assert.equal(args[args.indexOf('--max-turns') + 1], '300');
});

test('run sans --budget-usd : claude lancé sans plafond, message sans montant', async () => {
  const dir = join(tmp('bench-run-'), 'projet');
  const out = [];
  const { spawn, calls } = fakeSpawn((cwd) => simulateRun(cwd, 'quick'));
  await bench(['run', 'quick-bug', '--yes', '--dir', dir], {
    spawn, env: { PATH: process.env.PATH }, log: (l) => out.push(l), platform: 'linux',
  });
  assert.ok(!calls[0].args.includes('--max-budget-usd'));
  assert.doesNotMatch(out.join('\n'), /budget \d/);
  assert.match(out.join('\n'), /sans plafond de coût/);
});

/** spawn simulé : enregistre l'appel, exécute effect(cwd), puis rend une sortie JSON. */
function fakeSpawn(effect = () => {}, output = { type: 'result', total_cost_usd: 0.42, duration_ms: 1234, num_turns: 7, is_error: false }) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      try {
        effect(options.cwd);
      } catch (err) {
        child.emit('error', err);
        return;
      }
      child.stdout.end(JSON.stringify(output));
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  return { spawn, calls };
}

test('runClaude : sortie standard collectée, commande résolue, env transmis', async () => {
  const { spawn, calls } = fakeSpawn();
  const result = await runClaude({ args: ['-p', 'x'], cwd: tmpdir(), env: { A: '1' }, spawn, platform: 'linux' });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).total_cost_usd, 0.42);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, ['-p', 'x']);
  assert.deepEqual(calls[0].options.env, { A: '1' });
  assert.equal(calls[0].options.shell, false);

  const win = fakeSpawn();
  await runClaude({ args: ['-p', '/team a b'], cwd: tmpdir(), env: { Path: 'C:\\n' }, spawn: win.spawn, platform: 'win32', exists: (p) => p === 'C:\\n\\claude.cmd' });
  assert.equal(win.calls[0].command, '"C:\\n\\claude.cmd" "-p" "/team a b"');
  assert.deepEqual(win.calls[0].args, []);
  assert.equal(win.calls[0].options.shell, true);
});

// --- run.mjs ---

const silent = () => {};

test('run : refusé (code 2) sans --yes ni BENCH_ALLOW_API=1, claude jamais lancé', async () => {
  const { spawn, calls } = fakeSpawn();
  assert.equal(await bench(['run', 'quick-bug'], { spawn, env: {}, log: silent }), 2);
  assert.equal(calls.length, 0);
});

test('run : scénario réussi avec claude simulé → 0, résultat claude enregistré, rapport', async () => {
  const dir = join(tmp('bench-run-'), 'projet');
  const out = [];
  const { spawn, calls } = fakeSpawn((cwd) => simulateRun(cwd, 'quick'));
  const code = await bench(['run', 'quick-bug', '--yes', '--dir', dir, '--budget-usd', '1.5'], {
    spawn, env: { CLAUDECODE: '1', PATH: process.env.PATH }, log: (l) => out.push(l), platform: 'linux',
  });
  assert.equal(code, 0, out.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, dir);
  assert.equal(calls[0].options.env.CLAUDECODE, undefined);
  assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd') + 1], '1.5');
  assert.match(calls[0].args[1], /^\/team slugify\(''\) plante/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.agent-runs', 'bench-claude.json'), 'utf8')).total_cost_usd, 0.42);
  const report = out.join('\n');
  assert.match(report, /quick-bug : RÉUSSI/);
  assert.match(report, /coût 0\.42 \$/);

  // verify sur le même dossier : même verdict, sans lancer claude.
  assert.equal(await bench(['verify', 'quick-bug', dir], { spawn, env: {}, log: silent }), 0);
  assert.equal(calls.length, 1);
});

test('run : BENCH_ALLOW_API=1 remplace --yes ; un run qui ne fait rien échoue (1) avec les attentes en cause', async () => {
  const dir = join(tmp('bench-run-'), 'projet');
  const out = [];
  const { spawn } = fakeSpawn();
  const code = await bench(['run', 'quick-bug', '--dir', dir], { spawn, env: { BENCH_ALLOW_API: '1' }, log: (l) => out.push(l), platform: 'linux' });
  assert.equal(code, 1);
  const report = out.join('\n');
  assert.match(report, /quick-bug : ÉCHEC/);
  assert.match(report, /status : aucun run trouvé/);
});

test('verify et list : sans claude ; usage invalide → 2', async () => {
  const { spawn, calls } = fakeSpawn();
  const out = [];
  assert.equal(await bench(['list'], { spawn, env: {}, log: (l) => out.push(l) }), 0);
  for (const name of ['quick-bug', 'standard-feature', 'ambiguous', 'sensitive']) assert.match(out.join('\n'), new RegExp(name));
  const dir = join(tmp('bench-verify-'), 'projet');
  prepare('quick-bug', { dir });
  assert.equal(await bench(['verify', 'quick-bug', dir], { spawn, env: {}, log: silent }), 1);
  assert.equal(await bench(['verify', 'quick-bug'], { spawn, env: {}, log: silent }), 2);
  assert.equal(await bench(['inconnu'], { spawn, env: {}, log: silent }), 2);
  assert.equal(await bench(['run', 'all', '--yes', '--dir', dir], { spawn, env: {}, log: silent }), 2);
  assert.equal(calls.length, 0);
});

test('scénarios : chacun a une demande sûre pour cmd.exe et uniquement des attentes connues', () => {
  const names = listScenarios();
  assert.deepEqual([...names].sort(), ['ambiguous', 'quick-bug', 'sensitive', 'standard-feature']);
  for (const name of names) {
    const scenario = loadScenario(name);
    assert.ok(scenario.request && !/["%\r\n]/.test(scenario.request), `${name} : demande vide ou caractère refusé par cmd.exe`);
    const failures = evaluate({ state: null, runFiles: [], git: {}, claude: null }, scenario.expect).failures;
    assert.deepEqual(failures.filter((f) => f.startsWith('attente inconnue')), [], name);
  }
});
