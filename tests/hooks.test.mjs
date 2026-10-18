import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';
import { evaluateFile } from '../template/.claude/hooks/team/guard-files.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

/** Lance un hook d'une copie installée du template avec un payload JSON sur stdin. */
function runHook(root, script, payload) {
  const res = spawnSync(process.execPath, [join(root, '.claude/hooks/team', script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: root,
  });
  let json = null;
  try { json = res.stdout.trim() ? JSON.parse(res.stdout) : null; } catch { /* sortie non JSON */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}
const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;

// --- guard-bash : décisions pures ---

const ctx = { baseBranch: 'main', currentBranch: () => 'team/x' };
const decide = (command, c = ctx) => evaluateCommand(command, c)?.decision ?? null;

test('guard-bash : commandes courantes autorisées sans intervention', () => {
  for (const cmd of ['git status', 'git diff --staged', 'git log --oneline -20', 'npm test', 'git commit -m "feat: x"',
    'git switch -c team/x main', 'git tag', 'git tag -l', 'npm ci', 'git clean -n', 'git restore --staged a.txt',
    'cat .env.example', 'ls .envrc', 'git stash list']) {
    assert.equal(decide(cmd), null, cmd);
  }
});

test('guard-bash : push, PR, publication, actions destructives et dépendances demandent un accord', () => {
  for (const cmd of ['git push origin team/x', 'git push -u origin HEAD', 'git push --force origin team/x',
    'gh pr create --fill', 'gh pr create --draft --title x --body-file pr-body.md', 'npm publish', 'git tag v1.0.0', 'git reset --hard HEAD~1',
    'git clean -fd', 'git branch -D team/old', 'git checkout -- .', 'git restore src/a.js', 'git rebase main',
    'git commit --amend --no-edit', 'git stash drop', 'npm install lodash', 'pnpm add -D vitest',
    'yarn add react', 'pip install requests', 'git -C sub push', 'npm test && git push']) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('guard-bash : refus sans appel — branche de base, contournement des hooks, secrets, suppression massive', () => {
  for (const cmd of ['git push origin main', 'git push origin HEAD:main', 'git push --force origin +main',
    'git commit --no-verify -m x', 'git push --no-verify', 'cat .env', 'source .env.local', 'grep KEY .env.production',
    'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rm -fr .', 'gh pr merge 12', 'gh pr merge --auto --squash 3', 'glab mr merge 4']) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
});

test('guard-bash : commit et push sans destination interdits sur la branche de base', () => {
  const onBase = { baseBranch: 'main', currentBranch: () => 'main' };
  assert.equal(decide('git commit -m "fix"', onBase), 'deny');
  assert.equal(decide('git push', onBase), 'deny');
  assert.match(evaluateCommand('git add -A && git commit -m x', onBase).reason, /branche de base « main »/);
});

// --- guard-bash : hook réel ---

test('guard-bash (hook) : JSON de décision sur stdout ; entrée illisible bloquée (code 2)', () => {
  const root = templateCopy();
  const ask = runHook(root, 'guard-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'git push origin team/x' }, cwd: root });
  assert.equal(ask.code, 0);
  assert.equal(decisionOf(ask), 'ask');

  const ok = runHook(root, 'guard-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: root });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), '');

  const broken = runHook(root, 'guard-bash.mjs', 'pas du json');
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /bloqu/);
});

test('guard-bash (hook) : lit la branche de base dans team.json et la branche courante avec git', () => {
  const root = templateCopy();
  const teamPath = join(root, '.claude/team.json');
  writeFileSync(teamPath, JSON.stringify({ ...JSON.parse(readFileSync(teamPath, 'utf8')), baseBranch: 'develop' }));
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: root });
  const payload = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: root };
  assert.equal(decisionOf(runHook(root, 'guard-bash.mjs', payload)), 'deny');
  execFileSync('git', ['switch', '-q', '-c', 'team/x'], { cwd: root });
  assert.equal(decisionOf(runHook(root, 'guard-bash.mjs', payload)), null);
});

// --- guard-files ---

test('guard-files : secrets refusés en lecture comme en écriture', () => {
  const root = '/projet';
  for (const [tool, input] of [['Read', { file_path: '/projet/.env' }], ['Edit', { file_path: '/projet/api/.env.local' }],
    ['Grep', { pattern: 'KEY', path: '/projet/.env.production' }], ['Read', { file_path: '/home/u/.ssh/id_rsa' }],
    ['Read', { file_path: '/projet/certs/server.pem' }]]) {
    assert.equal(evaluateFile(tool, input, { projectDir: root })?.decision, 'deny', `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(evaluateFile('Read', { file_path: '/projet/.env.example' }, { projectDir: root }), null);
  assert.equal(evaluateFile('Read', { file_path: '/projet/src/env.ts' }, { projectDir: root }), null);
});

test('guard-files : modifier les garde-fous demande un accord ; l\'implementer ne touche ni .claude/ ni .agent-runs/', () => {
  const root = '/projet';
  assert.equal(evaluateFile('Edit', { file_path: '/projet/.claude/settings.json' }, { projectDir: root })?.decision, 'ask');
  assert.equal(evaluateFile('Write', { file_path: '/projet/.claude/hooks/team/guard-bash.mjs' }, { projectDir: root })?.decision, 'ask');
  assert.equal(evaluateFile('Read', { file_path: '/projet/.claude/settings.json' }, { projectDir: root }), null);
  assert.equal(evaluateFile('Edit', { file_path: '/projet/src/a.ts' }, { projectDir: root }), null);

  const impl = { projectDir: root, agentType: 'implementer' };
  assert.equal(evaluateFile('Write', { file_path: '/projet/.agent-runs/r/state.json' }, impl)?.decision, 'deny');
  assert.equal(evaluateFile('Edit', { file_path: '/projet/.claude/team.json' }, impl)?.decision, 'deny');
  assert.equal(evaluateFile('Edit', { file_path: '/projet/src/a.ts' }, impl), null);
  assert.equal(evaluateFile('Read', { file_path: '/projet/.agent-runs/r/plan.md' }, impl), null);
});

test('guard-files (hook) : décision JSON, entrée illisible bloquée', () => {
  const root = templateCopy();
  const r = runHook(root, 'guard-files.mjs', { tool_name: 'Read', tool_input: { file_path: join(root, '.env') }, cwd: root });
  assert.equal(decisionOf(r), 'deny');
  assert.equal(runHook(root, 'guard-files.mjs', '').code, 2);
});

// --- check-run-state (PostToolUse) ---

test('check-run-state : un state.json invalide est renvoyé au modèle (code 2), un fichier quelconque ignoré', () => {
  const root = templateCopy();
  const state = JSON.parse(readFileSync(join(root, '.claude/skills/team/templates/state.json'), 'utf8'));
  const path = join(root, '.agent-runs', state.id, 'state.json');
  writeFile(path, JSON.stringify({ ...state, status: 'ready_for_execution' }));
  const payload = { tool_name: 'Write', tool_input: { file_path: path }, cwd: root };
  const bad = runHook(root, 'check-run-state.mjs', payload);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /exige gates\.plan validée/);

  writeFile(path, JSON.stringify(state));
  assert.equal(runHook(root, 'check-run-state.mjs', payload).code, 0);
  assert.equal(runHook(root, 'check-run-state.mjs', { tool_name: 'Write', tool_input: { file_path: join(root, 'a.txt') } }).code, 0);
});

// --- keep-running (Stop) ---

function runWithStatus(root, status, sessionId = 'session-1', extra = {}) {
  const state = JSON.parse(readFileSync(join(root, '.claude/skills/team/templates/state.json'), 'utf8'));
  writeFile(join(root, '.agent-runs', state.id, 'state.json'), JSON.stringify({ ...state, status, sessionId, ...extra }));
  return join(root, '.agent-runs', state.id);
}

test('keep-running : un run en exécution de cette session empêche de s\'arrêter', () => {
  const root = templateCopy();
  runWithStatus(root, 'executing');
  const r = runHook(root, 'keep-running.mjs', { session_id: 'session-1', stop_hook_active: false, cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /2026-10-18-exemple/);
});

test('keep-running : laisse s\'arrêter en attente, pour une autre session, ou après une relance', () => {
  const root = templateCopy();
  runWithStatus(root, 'awaiting_plan_approval');
  assert.equal(runHook(root, 'keep-running.mjs', { session_id: 'session-1', stop_hook_active: false }).json, null);

  runWithStatus(root, 'executing', 'autre-session');
  assert.equal(runHook(root, 'keep-running.mjs', { session_id: 'session-1', stop_hook_active: false }).json, null);

  // Une relance sans progrès : le second arrêt (stop_hook_active) passe.
  runWithStatus(root, 'executing');
  assert.equal(runHook(root, 'keep-running.mjs', { session_id: 'session-1', stop_hook_active: false }).json?.decision, 'block');
  assert.equal(runHook(root, 'keep-running.mjs', { session_id: 'session-1', stop_hook_active: true }).json, null);
  // Sans .agent-runs/ : rien à faire, sans erreur.
  assert.equal(runHook(templateCopy(), 'keep-running.mjs', { session_id: 'session-1' }).code, 0);
});

test('keep-running : relance malgré stop_hook_active tant que state.json progresse', () => {
  const root = templateCopy();
  const stop = (active) => runHook(root, 'keep-running.mjs', { session_id: 'session-1', stop_hook_active: active }).json?.decision ?? null;
  const runDir = runWithStatus(root, 'executing');
  assert.equal(stop(false), 'block');
  const memory = JSON.parse(readFileSync(join(runDir, '.keep-running.json'), 'utf8'));
  assert.match(memory.digest, /^[0-9a-f]{64}$/);

  // Le run avance (state.json modifié) : nouvelle relance, même après une relance.
  runWithStatus(root, 'checking');
  assert.equal(stop(true), 'block');
  runWithStatus(root, 'reviewing');
  assert.equal(stop(true), 'block');
  // Plus de progrès : on laisse s'arrêter.
  assert.equal(stop(true), null);
  // Nouvel arrêt hors relance (après une réponse de l'utilisateur) : une relance de plus.
  assert.equal(stop(false), 'block');
  assert.equal(stop(true), null);
});

test('keep-running : awaiting_ci est un statut actif', () => {
  const root = templateCopy();
  runWithStatus(root, 'awaiting_ci');
  assert.equal(runHook(root, 'keep-running.mjs', { session_id: 'session-1', stop_hook_active: false }).json?.decision, 'block');
});

test('guard-bash : pas de mention de co-auteur dans un message de commit', () => {
  const heredoc = 'git commit -F - <<\'EOF\'\nfeat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF';
  assert.equal(decide(heredoc), 'deny');
  assert.equal(decide('git commit -m "fix: y" -m "co-authored-by: Bot <b@b>"'), 'deny');
  assert.match(evaluateCommand(heredoc, ctx).reason, /Co-Authored-By/);
  assert.equal(decide('git log --grep "Co-Authored-By"'), null);
  assert.equal(decide('git commit -m "docs: retire la mention co-auteur"'), null);
});
