import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseTask } from '../template/.claude/hooks/team/record-metrics.mjs';
import { summarize } from '../template/.claude/skills/team/scripts/metrics.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

function runHook(root, script, payload) {
  const res = spawnSync(process.execPath, [join(root, '.claude/hooks/team', script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function makeRun(root, id, state) {
  const dir = join(root, '.agent-runs', id);
  writeFile(join(dir, 'state.json'), JSON.stringify({ id, createdAt: '2026-10-18T10:00:00Z', ...state }));
  return dir;
}
const readLines = (dir) => readFileSync(join(dir, 'metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Entrée PostToolUse réelle sur l'outil Agent (champs relevés sur Claude Code).
const agentCall = (over = {}) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'S1',
  tool_name: 'Agent',
  tool_input: { prompt: 'Réalise T2…', description: 'implementer T2 #1', subagent_type: 'implementer', ...over.input },
  tool_response: {
    status: 'completed', content: [{ type: 'text', text: '…' }],
    totalDurationMs: 84213, totalToolUseCount: 23, totalTokens: 51234,
    usage: { input_tokens: 10, output_tokens: 2000, cache_read_input_tokens: 49224 },
  },
  ...over.payload,
});

test('parseTask : tâche lue dans la description « <agent> <Tn|spec|plan|consult|split> #<k> »', () => {
  assert.equal(parseTask('implementer T2 #1'), 'T2');
  assert.equal(parseTask('planner spec+plan #1'), 'spec+plan');
  assert.equal(parseTask('implementer T3.1 #2'), 'T3.1');
  assert.equal(parseTask('Relire le diff'), null);
  assert.equal(parseTask(undefined), null);
});

test('record-metrics : une ligne correcte depuis un vrai tool_response, modèle par défaut de l\'agent', () => {
  const root = templateCopy();
  const dir = makeRun(root, 'r1', { status: 'executing', sessionId: 'S1' });
  makeRun(root, 'old', { status: 'done', sessionId: 'S1' });
  const r = runHook(root, 'record-metrics.mjs', agentCall());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  const [line] = readLines(dir);
  assert.ok(!Number.isNaN(Date.parse(line.at)));
  assert.deepEqual({ ...line, at: undefined }, {
    at: undefined, kind: 'agent', agent: 'implementer', task: 'T2', model: 'sonnet',
    durationMs: 84213, toolUses: 23, tokens: 51234,
  });
  assert.ok(!existsSync(join(root, '.agent-runs/old/metrics.jsonl')));

  runHook(root, 'record-metrics.mjs', agentCall({ input: { model: 'opus' } }));
  assert.equal(readLines(dir).at(-1).model, 'opus');

  runHook(root, 'record-metrics.mjs', { hook_event_name: 'Stop', session_id: 'S1', stop_hook_active: false });
  assert.equal(readLines(dir).at(-1).kind, 'turn');
  assert.equal(readLines(dir).length, 3);
});

test('record-metrics : rien sans run actif de la session, ni pour un agent hors équipe ; jamais bloquant', () => {
  const root = templateCopy();
  const dir = makeRun(root, 'r1', { status: 'executing', sessionId: 'S1' });
  makeRun(root, 'r2', { status: 'cancelled', sessionId: 'S2' });
  for (const payload of [
    agentCall({ payload: { session_id: 'S2' } }),
    agentCall({ payload: { session_id: 'S3' } }),
    agentCall({ input: { subagent_type: 'Explore', description: 'Explore src' } }),
    { hook_event_name: 'Stop', session_id: 'S2' },
  ]) {
    const r = runHook(root, 'record-metrics.mjs', payload);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  }
  assert.ok(!existsSync(join(dir, 'metrics.jsonl')));
  assert.equal(runHook(root, 'record-metrics.mjs', 'pas du json').code, 0);
});

test('record-metrics et metrics : les développeurs spécialisés et documentation sont mesurés', () => {
  const root = templateCopy();
  const dir = makeRun(root, 'r1', { status: 'executing', sessionId: 'S1' });
  for (const agent of ['implementer-backend', 'implementer-frontend', 'documentation']) {
    runHook(root, 'record-metrics.mjs', agentCall({ input: { subagent_type: agent, description: `${agent} T2 #1` } }));
  }
  const lines = readLines(dir);
  assert.deepEqual(lines.map((l) => l.agent), ['implementer-backend', 'implementer-frontend', 'documentation']);
  assert.deepEqual(lines.map((l) => l.model), ['sonnet', 'sonnet', 'sonnet']);
  assert.equal(summarize({ id: 'r1', createdAt: '2026-10-18T10:00:00Z' }, lines).byTask.T2.implementerCalls, 3);
});

test('metrics : agrège durée murale, tours, agents et tâches', () => {
  const state = { id: 'r1', createdAt: '2026-10-18T10:00:00Z' };
  const lines = [
    { at: '2026-10-18T10:05:00Z', kind: 'agent', agent: 'planner', task: 'spec+plan', model: 'opus', durationMs: 60000, toolUses: 10, tokens: 1000 },
    { at: '2026-10-18T10:10:00Z', kind: 'agent', agent: 'implementer', task: 'T1', model: 'sonnet', durationMs: 120000, toolUses: 20, tokens: 3000 },
    { at: '2026-10-18T10:11:00Z', kind: 'deliverable_rejected', agent: 'implementer' },
    { at: '2026-10-18T10:20:00Z', kind: 'agent', agent: 'implementer', task: 'T1', model: 'opus', durationMs: 30000, toolUses: 5, tokens: 500 },
    { at: '2026-10-18T10:25:00Z', kind: 'turn' },
    { at: '2026-10-18T10:30:00Z', kind: 'turn' },
  ];
  const s = summarize(state, lines);
  assert.equal(s.wallMs, 30 * 60000);
  assert.equal(s.turns, 2);
  assert.deepEqual(s.byAgent.implementer, { calls: 2, durationMs: 150000, toolUses: 25, tokens: 3500, rejections: 1 });
  assert.deepEqual(s.byAgent.planner, { calls: 1, durationMs: 60000, toolUses: 10, tokens: 1000, rejections: 0 });
  assert.deepEqual(s.byTask.T1, { implementerCalls: 2, models: ['sonnet', 'opus'] });
  assert.deepEqual(summarize(state, []).turns, 0);
});

test('metrics.mjs (CLI) : texte, --json, et erreur sur run introuvable', () => {
  const root = templateCopy();
  const dir = makeRun(root, 'r1', { status: 'executing' });
  writeFile(join(dir, 'metrics.jsonl'), [
    JSON.stringify({ at: '2026-10-18T10:10:00Z', kind: 'agent', agent: 'implementer', task: 'T1', model: 'sonnet', durationMs: 1000, toolUses: 2, tokens: 30 }),
    'ligne abîmée',
    '',
  ].join('\n'));
  const script = join(root, '.claude/skills/team/scripts/metrics.mjs');
  const text = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /implementer/);
  const json = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(json.stdout).byAgent.implementer.calls, 1);
  assert.equal(spawnSync(process.execPath, [script, join(root, '.agent-runs/absent')], { encoding: 'utf8' }).status, 2);
});
