import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AGENTS, extractDeliverable, validateDeliverable } from '../template/.claude/skills/team/scripts/deliverable.mjs';
import { parseFrontmatter, validate } from '../validate.mjs';
import { TEMPLATE_CLAUDE, TEMPLATE_ROOT, templateCopy, writeFile } from './helpers.mjs';

/** Lance un hook d'une copie installée du template avec un payload JSON sur stdin. */
function runHook(root, script, payload, env = {}) {
  const res = spawnSync(process.execPath, [join(root, '.claude/hooks/team', script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  let json = null;
  try { json = res.stdout.trim() ? JSON.parse(res.stdout) : null; } catch { /* sortie non JSON */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

const block = (obj) => `Résumé du travail.\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;

const finding = (over = {}) => ({
  id: 'F1', severity: 'major', file: 'src/a.js', line: 12, problem: 'Cas vide non géré.',
  scenario: 'slugify("") lève une exception.', fix: 'Retourner "" tôt.', confidence: 'confirmed', source: 'review', ...over,
});

const reviewer = (over = {}) => ({
  agent: 'code-reviewer', run: 'r1', status: 'ready', questions: [], task: 'T2', verdict: 'approve',
  findings: [], acceptance: [{ id: 'AC1', status: 'covered', evidence: 'test/a.test.js:4' }],
  checks: [{ command: 'npm test', result: '12 passed' }], ...over,
});

const implementer = (over = {}) => ({
  agent: 'implementer', run: 'r1', status: 'ready', questions: [], task: 'T1',
  files: [{ path: 'src/a.js', change: 'garde sur chaîne vide' }],
  acceptance: [{ id: 'AC1', status: 'covered', evidence: 'test/a.test.js:4' }],
  evidence: [{ command: 'npm test', result: 'échec puis 12 passed' }], deviations: [], ...over,
});

const planner = (over = {}) => ({
  agent: 'planner', run: 'r1', status: 'ready', questions: [], mode: 'spec+plan',
  acceptanceCriteria: ['AC1', 'AC2'], taskIds: ['T1'], ...over,
});

// --- extractDeliverable ---

test('extractDeliverable : dernier bloc json, rien après sauf des espaces', () => {
  const text = `Exemple :\n\`\`\`json\n{"a":1}\n\`\`\`\nPuis le livrable.\n\`\`\`json\n{"b":2}\n\`\`\`\n  \n`;
  assert.deepEqual(extractDeliverable(text), { data: { b: 2 }, error: null });
});

test('extractDeliverable : absence de bloc, texte après le bloc, JSON invalide → erreur', () => {
  assert.match(extractDeliverable('Statut : ready, tout va bien.').error, /aucun bloc/);
  assert.match(extractDeliverable('```json\n{"a":1}\n```\nEt une dernière remarque.').error, /après le bloc/);
  assert.match(extractDeliverable('```json\n{"a":1}\n```\n```bash\nls\n```').error, /après le bloc/);
  assert.match(extractDeliverable('```json\n{"a":\n```').error, /JSON invalide/);
  assert.match(extractDeliverable('```json\n[1, 2]\n```').error, /objet/);
});

// --- validateDeliverable ---

test('validateDeliverable : livrables conformes des trois agents', () => {
  assert.deepEqual(validateDeliverable(planner(), 'planner'), []);
  assert.deepEqual(validateDeliverable(implementer(), 'implementer'), []);
  assert.deepEqual(validateDeliverable(reviewer(), 'code-reviewer'), []);
  assert.deepEqual(validateDeliverable(reviewer({ run: null, task: null }), 'code-reviewer'), []);
  assert.deepEqual(validateDeliverable(reviewer({ verdict: 'changes_requested', findings: [finding()] }), 'code-reviewer'), []);
  assert.deepEqual(validateDeliverable(planner({ mode: 'consult', acceptanceCriteria: undefined, taskIds: undefined,
    answer: { decision: 'Garder le cache', rationale: 'Plus simple', constraints: [] } }), 'planner'), []);
  assert.deepEqual(validateDeliverable(planner({ mode: 'split', acceptanceCriteria: undefined, taskIds: undefined,
    replaces: 'T3', tasks: [{ id: 'T3.1', title: 'x', acceptanceCriteria: ['AC1'], dependsOn: [], files: ['src/a.js'],
      newFiles: [], requiresHuman: false }] }), 'planner'), []);
});

test('validateDeliverable : champs communs et cohérence', () => {
  const errs = (obj, agent) => validateDeliverable(obj, agent).join('\n');
  assert.match(errs(implementer({ agent: 'planner' }), 'implementer'), /agent/);
  assert.match(errs(implementer({ status: 'done' }), 'implementer'), /status/);
  assert.match(errs(implementer({ run: 3 }), 'implementer'), /run/);
  assert.match(errs(implementer({ status: 'needs_input', questions: [] }), 'implementer'), /question/);
  assert.match(errs(implementer({ status: 'needs_input', questions: [{ kind: 'urgent', text: 'x' }] }), 'implementer'), /kind/);
  assert.match(errs(implementer({ files: [] }), 'implementer'), /files/);
  assert.match(errs(implementer({ evidence: [] }), 'implementer'), /evidence/);
  assert.match(errs(implementer({ acceptance: [{ id: 'AC1', status: 'ok', evidence: '' }] }), 'implementer'), /acceptance/);
  assert.match(errs(implementer({ task: '' }), 'implementer'), /task/);
  assert.match(errs(planner({ mode: 'draft' }), 'planner'), /mode/);
  assert.match(errs(planner({ acceptanceCriteria: [] }), 'planner'), /acceptanceCriteria/);
  assert.match(errs(planner({ mode: 'consult' }), 'planner'), /answer/);
  assert.match(errs(planner({ mode: 'split', replaces: 'T3', tasks: [] }), 'planner'), /tasks/);
  assert.match(errs(reviewer(), 'inconnu'), /agent/);
  assert.match(errs([], 'implementer'), /objet/);
});

test('validateDeliverable : verdict cohérent avec les constats', () => {
  const errs = (obj) => validateDeliverable(obj, 'code-reviewer').join('\n');
  assert.match(errs(reviewer({ findings: [finding()] })), /approve/);
  assert.match(errs(reviewer({ findings: [finding({ severity: 'critical' })] })), /approve/);
  assert.deepEqual(validateDeliverable(reviewer({ findings: [finding({ confidence: 'plausible' })] }), 'code-reviewer'), []);
  assert.deepEqual(validateDeliverable(reviewer({ findings: [finding({ severity: 'minor' })] }), 'code-reviewer'), []);
  assert.match(errs(reviewer({ verdict: 'changes_requested' })), /changes_requested/);
  assert.match(errs(reviewer({ verdict: 'ok' })), /verdict/);
  assert.match(errs(reviewer({ findings: [finding({ severity: 'high' })] })), /severity/);
  assert.match(errs(reviewer({ findings: [finding({ line: '12' })] })), /line/);
  assert.match(errs(reviewer({ findings: [finding({ source: 'blog' })] })), /source/);
});

// --- check-deliverable (hook SubagentStop) ---

function runDir(root, id = 'r1') {
  const dir = join(root, '.agent-runs', id);
  writeFile(join(dir, 'state.json'), JSON.stringify({ id, status: 'reviewing', sessionId: 'S1', createdAt: '2026-10-18T10:00:00Z' }));
  return dir;
}
const stop = (agent, message, over = {}) => ({
  hook_event_name: 'SubagentStop', session_id: 'S1', agent_id: 'a1', agent_type: agent,
  agent_transcript_path: '/tmp/x.jsonl', last_assistant_message: message, stop_hook_active: false, ...over,
});

test('check-deliverable : sans bloc, texte après le bloc, approve avec constat majeur confirmé → block', () => {
  const root = templateCopy();
  runDir(root);
  for (const message of ['Statut : ready\nTout est fait.', `${block(implementer())}Merci !`]) {
    const r = runHook(root, 'check-deliverable.mjs', stop('implementer', message));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json?.decision, 'block', message);
    assert.match(r.json.reason, /deliverables\.md/);
  }
  const r = runHook(root, 'check-deliverable.mjs', stop('code-reviewer', block(reviewer({ findings: [finding()] }))));
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /approve/);
  assert.ok(!existsSync(join(root, '.agent-runs/r1/review-T2-1.json')));
});

test('livrable des développeurs spécialisés et de documentation : schéma implementer, agent = le sien', () => {
  for (const agent of ['implementer-backend', 'implementer-frontend', 'documentation']) {
    assert.deepEqual(validateDeliverable(implementer({ agent }), agent), [], agent);
    assert.match(validateDeliverable(implementer({ agent, files: [] }), agent).join('\n'), /files/, agent);
    assert.match(validateDeliverable(implementer(), agent).join('\n'), /agent/, agent);
  }
  const root = templateCopy();
  const dir = runDir(root);
  const ko = runHook(root, 'check-deliverable.mjs', stop('implementer-backend', 'Fini, sans bloc.'));
  assert.equal(ko.json?.decision, 'block');
  const ok = runHook(root, 'check-deliverable.mjs', stop('documentation', block(implementer({ agent: 'documentation' }))));
  assert.equal(ok.stdout.trim(), '');
  assert.ok(readdirSync(join(dir, 'deliverables')).some((f) => /-documentation-T1\.json$/.test(f)));
});

test('check-deliverable : jamais de block si stop_hook_active ; le rejet est mesuré', () => {
  const root = templateCopy();
  const dir = runDir(root);
  const r = runHook(root, 'check-deliverable.mjs', stop('implementer', 'pas de bloc', { stop_hook_active: true }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /livrable/);
  const lines = readFileSync(join(dir, 'metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).kind, 'deliverable_rejected');
  assert.equal(lines.at(-1).agent, 'implementer');
});

test('check-deliverable : relecteur valide pour T2 → review-T2-1.json puis review-T2-2.json identiques au bloc', () => {
  const root = templateCopy();
  const dir = runDir(root);
  const obj = reviewer();
  const stateBefore = readFileSync(join(dir, 'state.json'), 'utf8');
  for (const k of [1, 2]) {
    const r = runHook(root, 'check-deliverable.mjs', stop('code-reviewer', block(obj)));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `review-T2-${k}.json`), 'utf8')), obj);
  }
  assert.deepEqual(readdirSync(join(dir, 'deliverables')).sort(), ['001-code-reviewer-T2.json', '002-code-reviewer-T2.json']);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), stateBefore, 'state.json jamais modifié');

  runHook(root, 'check-deliverable.mjs', stop('code-reviewer', block(reviewer({ task: null }))));
  assert.ok(existsSync(join(dir, 'review-1.json')));
  runHook(root, 'check-deliverable.mjs', stop('planner', block(planner())));
  assert.ok(existsSync(join(dir, 'deliverables', '004-planner.json')));
});

test('check-deliverable : lit SubagentHandback ou le texte final dans agent_transcript_path si last_assistant_message est vide', () => {
  const root = templateCopy();
  const dir = runDir(root);
  const transcript = join(root, 'subagent.jsonl');
  const handbackLine = (msg) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: msg } }] },
  });
  const toolResultLine = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }] },
  });

  writeFile(transcript, [handbackLine(block(implementer())), toolResultLine].join('\n'));
  const ok = runHook(root, 'check-deliverable.mjs', stop('implementer', '', { agent_transcript_path: transcript }));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), '');
  assert.ok(existsSync(join(dir, 'deliverables', '001-implementer-T1.json')));

  // Un livrable invalide dans SubagentHandback renvoie l'erreur de schéma réelle (pas « aucun bloc »).
  writeFile(transcript, [handbackLine(block(implementer({ files: [] }))), toolResultLine].join('\n'));
  const ko = runHook(root, 'check-deliverable.mjs', stop('implementer', '', { agent_transcript_path: transcript }));
  assert.equal(ko.json?.decision, 'block');
  assert.match(ko.json.reason, /files/);

  // Repli sur le dernier bloc text d'assistant si SubagentHandback n'est pas utilisé.
  const textLine = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: block(planner()) }] },
  });
  const thinkingLine = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }] },
  });
  writeFile(transcript, [textLine, thinkingLine].join('\n'));
  const okText = runHook(root, 'check-deliverable.mjs', stop('planner', undefined, { agent_transcript_path: transcript }));
  assert.equal(okText.stdout.trim(), '');
  assert.ok(existsSync(join(dir, 'deliverables', '002-planner.json')));
});

test('check-deliverable : run null ou introuvable → rien écrit ; agent hors équipe jamais bloqué ; entrée illisible → 0', () => {
  const root = templateCopy();
  runDir(root);
  const none = runHook(root, 'check-deliverable.mjs', stop('code-reviewer', block(reviewer({ run: null }))));
  assert.equal(none.stdout.trim(), '');
  const ghost = runHook(root, 'check-deliverable.mjs', stop('code-reviewer', block(reviewer({ run: 'absent' }))));
  assert.equal(ghost.stdout.trim(), '');
  assert.ok(!existsSync(join(root, '.agent-runs/r1/review-T2-1.json')));
  assert.ok(!existsSync(join(root, '.agent-runs/absent')));

  const other = runHook(root, 'check-deliverable.mjs', stop('Explore', 'Pas de bloc du tout.'));
  assert.equal(other.code, 0);
  assert.equal(other.stdout.trim(), '');

  const broken = runHook(root, 'check-deliverable.mjs', 'pas du json');
  assert.equal(broken.code, 0);
  assert.match(broken.stderr, /illisible/);
});

test('deliverable.mjs (CLI) : 0 si valide, 1 sinon', () => {
  const root = templateCopy();
  const script = join(root, '.claude/skills/team/scripts/deliverable.mjs');
  writeFile(join(root, 'ok.md'), block(implementer()));
  writeFile(join(root, 'ko.md'), block(implementer({ files: [] })));
  const run = (file) => spawnSync(process.execPath, [script, join(root, file), '--agent', 'implementer'], { encoding: 'utf8' });
  assert.equal(run('ok.md').status, 0);
  const ko = run('ko.md');
  assert.equal(ko.status, 1);
  assert.match(ko.stderr, /files/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
});

// --- Câblage : settings.json et agents ---

test('settings.json : check-deliverable sur SubagentStop, record-metrics sur Agent|Task et Stop, scripts autorisés', () => {
  const settings = JSON.parse(readFileSync(join(TEMPLATE_CLAUDE, 'settings.json'), 'utf8'));
  const commandsOf = (event, matcher) => (settings.hooks[event] ?? [])
    .filter((g) => (matcher === undefined ? !g.matcher : g.matcher === matcher)).flatMap((g) => g.hooks.map((h) => h.command));
  // Le matcher couvre exactement les agents de l'équipe : un agent oublié échapperait au contrôle.
  const subagentStop = (settings.hooks.SubagentStop ?? []).find((g) => g.hooks.some((h) => h.command.includes('check-deliverable.mjs')));
  assert.ok(subagentStop, 'check-deliverable déclaré sur SubagentStop');
  assert.deepEqual(subagentStop.matcher.split('|').sort(), [...AGENTS].sort());
  assert.ok(commandsOf('PostToolUse', 'Agent|Task').some((c) => c.includes('record-metrics.mjs')));
  const stopCommands = commandsOf('Stop');
  assert.ok(stopCommands.some((c) => c.includes('record-metrics.mjs')));
  assert.ok(stopCommands.some((c) => c.includes('keep-running.mjs')));
  for (const name of ['check-state', 'run-checks', 'check-pr', 'claim-run', 'check-plan', 'check-scope', 'sensitive',
    'deliverable', 'metrics', 'ci-wait', 'pr-comments', 'lessons', 'plan-waves']) {
    assert.ok(settings.permissions.allow.includes(`Bash(node .claude/skills/team/scripts/${name}.mjs *)`), name);
  }
});

test('agents : bloc final renvoyé à deliverables.md, corps ≤ 100 lignes, validate sans avertissement d\'agent', () => {
  for (const name of AGENTS) {
    const { data, body } = parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'agents', `${name}.md`), 'utf8'));
    // Le renvoi au livrable est dans le corps, ou dans la procédure commune préchargée.
    const preloaded = data.skills.map((s) => readFileSync(join(TEMPLATE_CLAUDE, 'skills', s, 'SKILL.md'), 'utf8')).join('\n');
    assert.match(`${body}\n${preloaded}`, /deliverables\.md/, name);
    assert.ok(body.split(/\r?\n/).length <= 100, `${name} : corps trop long`);
  }
  // Procédure commune une seule fois : les trois implementers la préchargent.
  for (const name of ['implementer', 'implementer-backend', 'implementer-frontend']) {
    const { data } = parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'agents', `${name}.md`), 'utf8'));
    assert.deepEqual(data.skills.slice(0, 2), ['team-rules', 'team-implementer'], name);
  }
  assert.ok(existsSync(join(TEMPLATE_CLAUDE, 'skills/team/deliverables.md')));
  const { errors, warnings } = validate(TEMPLATE_ROOT);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter((w) => w.startsWith('agents/')), []);
});
