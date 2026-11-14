// Agents de revue de PR : schémas de livrables, hook check-deliverable (copie dans
// .agent-reviews/), garde-fous guard-bash (publish, review-batch), câblage du template.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';
import { AGENTS, PR_REVIEWERS, REVIEW_AGENTS, validateDeliverable } from '../template/.claude/skills/team/scripts/deliverable.mjs';
import { parseFrontmatter, splitList, validate } from '../validate.mjs';
import { REPO_DIR, TEMPLATE_CLAUDE, TEMPLATE_ROOT, templateCopy, writeFile } from './helpers.mjs';
import { finding, guardCtx, reviewerDeliverable, verifierDeliverable } from './review-fixtures.mjs';

const errs = (obj, agent) => validateDeliverable(obj, agent).join('\n');
const verdicts = (over = {}) => verifierDeliverable([
  { finding: 'R1', verdict: 'confirmed', reason: 'Reproduit.' },
  { finding: 'R2', verdict: 'downgraded', severity: 'minor', reason: 'Cas rare.' },
  { finding: 'R3', verdict: 'rejected', reason: 'Validé en amont.' },
], over);

// --- Schémas ---

test('livrables de revue : les quatre agents, livrables conformes', () => {
  assert.deepEqual(REVIEW_AGENTS, ['cc-pr-reviewer-frontend', 'cc-pr-reviewer-backend', 'cc-pr-reviewer-architecture', 'cc-pr-verifier']);
  for (const agent of REVIEW_AGENTS) assert.ok(AGENTS.includes(agent), agent);
  for (const axis of ['frontend', 'backend', 'architecture']) {
    assert.deepEqual(validateDeliverable(reviewerDeliverable(axis), `cc-pr-reviewer-${axis}`), [], axis);
    assert.deepEqual(validateDeliverable(reviewerDeliverable(axis, []), `cc-pr-reviewer-${axis}`), [], `${axis} sans constat`);
  }
  assert.deepEqual(validateDeliverable(reviewerDeliverable('backend', [
    finding({ line: null, endLine: null }),
    finding({ id: 'B2', kind: 'question', scenario: '', fix: '', proof: 'none', evidence: '' }),
    finding({ id: 'B3', endLine: 14, suggestion: 'const x = 1;' }),
    finding({ id: 'B4', suggestion: undefined, endLine: null }),
  ]), 'cc-pr-reviewer-backend'), []);
  assert.deepEqual(validateDeliverable(verdicts(), 'cc-pr-verifier'), []);
  assert.deepEqual(validateDeliverable(verifierDeliverable([]), 'cc-pr-verifier'), []);
  assert.deepEqual(validateDeliverable(reviewerDeliverable('backend', [], { status: 'needs_input', questions: [{ kind: 'product', text: 'Quelle règle ?' }] }), 'cc-pr-reviewer-backend'), []);
});

test('livrables de revue : champs communs — run null, review pr-<n>, round ≥ 1, agent, axe', () => {
  for (const agent of REVIEW_AGENTS) {
    const make = (over) => (agent === 'cc-pr-verifier' ? verdicts(over) : reviewerDeliverable(agent.slice('cc-pr-reviewer-'.length), [finding()], over));
    assert.match(errs(make({ run: 'r1' }), agent), /run : doit être null/, agent);
    for (const review of [undefined, 42, 'pr-', '42', 'pr-42/../x', '../pr-1']) assert.match(errs(make({ review }), agent), /review : identifiant/, `${agent} ${review}`);
    for (const round of [undefined, 0, -1, 1.5, '1']) assert.match(errs(make({ round }), agent), /round : entier ≥ 1/, `${agent} ${round}`);
    assert.match(errs(make({ status: 'done' }), agent), /status/, agent);
    assert.match(errs(make({ status: 'needs_input' }), agent), /question/, agent);
    assert.match(errs(make({ agent: 'cc-code-reviewer' }), agent), /agent/, agent);
  }
  assert.match(errs(reviewerDeliverable('backend'), 'cc-pr-reviewer-frontend'), /agent/);
  assert.match(errs(reviewerDeliverable('backend', [finding()], { axis: 'frontend' }), 'cc-pr-reviewer-backend'), /axis : « frontend » attendu « backend »/);
  assert.match(errs(reviewerDeliverable('backend', [finding()], { axis: undefined }), 'cc-pr-reviewer-backend'), /axis/);
});

test('livrables de revue : chaque refus d\'un constat de relecteur', () => {
  const bad = (over, re) => assert.match(errs(reviewerDeliverable('backend', [finding(over)]), 'cc-pr-reviewer-backend'), re, JSON.stringify(over));
  for (const key of ['id', 'file', 'snippet', 'title', 'problem', 'comment']) {
    bad({ [key]: '' }, new RegExp(`findings\\[0\\]\\.${key} : texte non vide`));
    bad({ [key]: undefined }, new RegExp(`findings\\[0\\]\\.${key}`));
  }
  bad({ severity: 'high' }, /severity/);
  bad({ kind: 'bug' }, /kind/);
  bad({ proof: 'trust' }, /proof/);
  bad({ scenario: '' }, /scenario/);
  bad({ fix: '   ' }, /fix/);
  bad({ kind: 'question', scenario: undefined }, /scenario/);
  bad({ line: 0 }, /line : entier > 0 ou null/);
  bad({ line: '12' }, /line/);
  bad({ line: undefined }, /line/);
  bad({ endLine: 11 }, /endLine/);
  bad({ endLine: undefined }, /endLine/);
  bad({ line: null, endLine: 12 }, /endLine/);
  bad({ evidence: '' }, /evidence : texte obligatoire, vide seulement si proof vaut none/);
  bad({ evidence: undefined, proof: 'none' }, /evidence/);
  bad({ regression: 'non' }, /regression/);
  bad({ preexisting: 'oui' }, /preexisting : true, false ou absent/);
  bad({ preexisting: true, regression: true }, /preexisting : incompatible avec regression/);
  assert.equal(errs(reviewerDeliverable('backend', [finding({ preexisting: true })]), 'cc-pr-reviewer-backend'), '');
  bad({ suggestion: 12 }, /suggestion : texte ou null/);
  bad({ line: null, endLine: null, suggestion: 'x' }, /suggestion : exige line/);

  const agent = 'cc-pr-reviewer-backend';
  assert.match(errs(reviewerDeliverable('backend', [finding(), finding()]), agent), /identifiant « B1 » en double/);
  assert.match(errs(reviewerDeliverable('backend', 'aucun'), agent), /findings : doit être une liste/);
  assert.match(errs(reviewerDeliverable('backend', ['texte']), agent), /findings\[0\] : doit être un objet/);
  assert.match(errs(reviewerDeliverable('backend', [], { checked: undefined }), agent), /checked : doit être une liste de textes/);
  assert.match(errs(reviewerDeliverable('backend', [], { checked: [''] }), agent), /checked/);
  assert.match(errs(reviewerDeliverable('backend', [], { notReviewed: 'tout' }), agent), /notReviewed/);
  assert.match(errs(reviewerDeliverable('backend', [], { notReviewed: [3] }), agent), /notReviewed/);
});

test('livrables de revue : chaque refus d\'un verdict du vérificateur', () => {
  const bad = (verdict, re) => assert.match(errs(verifierDeliverable([verdict]), 'cc-pr-verifier'), re, JSON.stringify(verdict));
  bad({ finding: '', verdict: 'confirmed', reason: 'x' }, /verdicts\[0\]\.finding/);
  bad({ finding: 'R1', verdict: 'confirmed', reason: '' }, /verdicts\[0\]\.reason : texte non vide/);
  bad({ finding: 'R1', verdict: 'confirmed' }, /reason/);
  bad({ finding: 'R1', verdict: 'maybe', reason: 'x' }, /verdict/);
  bad({ finding: 'R1', verdict: 'downgraded', reason: 'x' }, /severity : major ou minor obligatoire/);
  bad({ finding: 'R1', verdict: 'downgraded', severity: 'critical', reason: 'x' }, /strictement plus basse/);
  bad({ finding: 'R1', verdict: 'downgraded', severity: 'low', reason: 'x' }, /severity/);
  bad({ finding: 'R1', verdict: 'confirmed', severity: 'minor', reason: 'x' }, /severity : réservé au verdict downgraded/);
  assert.match(errs(verifierDeliverable(undefined), 'cc-pr-verifier'), /verdicts : doit être une liste/);
  assert.match(errs(verifierDeliverable(['R1']), 'cc-pr-verifier'), /verdicts\[0\] : doit être un objet/);
});

// --- Hook check-deliverable ---

function runHook(root, payload) {
  const res = spawnSync(process.execPath, [join(root, '.claude/hooks/team/check-deliverable.mjs')], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  let json = null;
  try { json = res.stdout.trim() ? JSON.parse(res.stdout) : null; } catch { /* sortie non JSON */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}
const block = (obj) => `Ce que j'ai relu.\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
const stop = (agent, message, over = {}) => ({
  hook_event_name: 'SubagentStop', session_id: 'S1', agent_id: 'a1', agent_type: agent,
  agent_transcript_path: '/tmp/x.jsonl', last_assistant_message: message, stop_hook_active: false, ...over,
});
function reviewStore(root, rounds = [1]) {
  const dir = join(root, '.agent-reviews', 'pr-42');
  writeFile(join(dir, 'review.json'), JSON.stringify({ version: 1, id: 'pr-42' }));
  for (const n of rounds) writeFile(join(dir, 'rounds', String(n), 'pr.json'), '{}');
  return dir;
}

test('check-deliverable : livrable valide d\'un agent de revue → copié dans .agent-reviews/<review>/rounds/<round>/deliverables/', () => {
  const root = templateCopy();
  const dir = reviewStore(root, [1, 2]);
  const sent = [
    ['cc-pr-reviewer-backend', reviewerDeliverable('backend')],
    ['cc-pr-reviewer-frontend', reviewerDeliverable('frontend', [])],
    ['cc-pr-reviewer-architecture', reviewerDeliverable('architecture', [finding({ id: 'A1' })])],
    ['cc-pr-verifier', verdicts()],
  ];
  for (const [agent, data] of sent) {
    const r = runHook(root, stop(agent, block(data)));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', `${agent} : ${r.stdout}`);
  }
  const files = readdirSync(join(dir, 'rounds', '1', 'deliverables')).sort();
  assert.deepEqual(files, ['001-cc-pr-reviewer-backend.json', '002-cc-pr-reviewer-frontend.json', '003-cc-pr-reviewer-architecture.json', '004-cc-pr-verifier.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'rounds', '1', 'deliverables', files[0]), 'utf8')), sent[0][1]);

  runHook(root, stop('cc-pr-reviewer-backend', block(reviewerDeliverable('backend', [], { round: 2 }))));
  assert.deepEqual(readdirSync(join(dir, 'rounds', '2', 'deliverables')), ['001-cc-pr-reviewer-backend.json']);
  assert.equal(readFileSync(join(dir, 'review.json'), 'utf8'), JSON.stringify({ version: 1, id: 'pr-42' }), 'review.json jamais modifié par le hook');
  assert.ok(!existsSync(join(root, '.agent-runs')), 'rien dans .agent-runs/');
});

test('check-deliverable : livrable de revue invalide → block ; revue ou round introuvable → rien écrit, pas de block', () => {
  const root = templateCopy();
  const dir = reviewStore(root);
  for (const [agent, message, re] of [
    ['cc-pr-reviewer-backend', 'Rien à signaler, sans bloc.', /aucun bloc/],
    ['cc-pr-reviewer-backend', block(reviewerDeliverable('backend', [finding({ comment: '' })])), /comment/],
    ['cc-pr-reviewer-frontend', block(reviewerDeliverable('backend')), /agent/],
    ['cc-pr-verifier', block(verifierDeliverable([{ finding: 'R1', verdict: 'rejected' }])), /reason/],
    ['cc-pr-verifier', block(verdicts({ review: '../../etc' })), /review/],
  ]) {
    const r = runHook(root, stop(agent, message));
    assert.equal(r.json?.decision, 'block', agent);
    assert.match(r.json.reason, re);
    assert.match(r.json.reason, /deliverables\.md/);
  }
  assert.ok(!existsSync(join(dir, 'rounds', '1', 'deliverables')));
  const final = runHook(root, stop('cc-pr-verifier', 'toujours rien', { stop_hook_active: true }));
  assert.equal(final.stdout.trim(), '', 'jamais de block au second arrêt');

  for (const over of [{ review: 'pr-7' }, { round: 3 }]) {
    const r = runHook(root, stop('cc-pr-reviewer-backend', block(reviewerDeliverable('backend', [], over))));
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /introuvable/);
  }
  assert.ok(!existsSync(join(root, '.agent-reviews', 'pr-7')));
  assert.ok(!existsSync(join(dir, 'rounds', '3')));
});

// --- guard-bash ---

const decide = (command) => evaluateCommand(command, guardCtx)?.decision ?? null;

test('guard-bash revue : publish.mjs sans --dry-run demande un accord, quelle que soit la forme', () => {
  for (const cmd of [
    'node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42',
    'node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42 --event APPROVE',
    'node ./.claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42',
    'node "C:\\projet\\.claude\\skills\\team-review\\scripts\\publish.mjs" .agent-reviews\\pr-42',
    'node.exe /home/u/projet/.claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42',
    '& node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42',
    'cd projet && node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42',
    'echo $(node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42)',
    'node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42 --dry-run-ish',
    'node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42 --dry-run && node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  assert.match(evaluateCommand('node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42', guardCtx).reason, /publication d'une revue sur GitHub : accord explicite requis/);
});

test('guard-bash revue : --dry-run et les scripts de lecture ou locaux passent sans question', () => {
  for (const cmd of [
    'node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-42 --dry-run',
    'node .claude/skills/team-review/scripts/publish.mjs --dry-run .agent-reviews/pr-42 --event REQUEST_CHANGES',
    'node .claude/skills/team-review/scripts/pr-list.mjs --pending',
    'node .claude/skills/team-review/scripts/pr-fetch.mjs 42',
    'node .claude/skills/team-review/scripts/findings.mjs .agent-reviews/pr-42',
    'node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-42 R1 --decision ok',
    'node .claude/skills/team-review/scripts/stats.mjs --json',
    'node .claude/skills/team-review/scripts/serve.mjs .agent-reviews/pr-42',
    'node .claude/skills/team-review/scripts/review-batch.mjs',
    'node .claude/skills/team-review/scripts/review-batch.mjs --max 2',
    'node scripts/publish.mjs',
    'node .claude/skills/team/scripts/check-pr.mjs .agent-runs/r1',
  ]) {
    assert.equal(decide(cmd), null, cmd);
  }
});

test('guard-bash revue : review-batch.mjs --yes demande un accord', () => {
  for (const cmd of [
    'node .claude/skills/team-review/scripts/review-batch.mjs --yes',
    'node .claude/skills/team-review/scripts/review-batch.mjs --max 5 --yes',
    'node "C:\\projet\\.claude\\skills\\team-review\\scripts\\review-batch.mjs" --yes',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

// --- Câblage du template ---

test('template : settings.json autorise les scripts de lecture ou locaux, jamais publish ni review-batch', () => {
  const settings = JSON.parse(readFileSync(join(TEMPLATE_CLAUDE, 'settings.json'), 'utf8'));
  for (const name of ['pr-list', 'pr-fetch', 'findings', 'decisions', 'stats', 'serve', 'source']) {
    assert.ok(settings.permissions.allow.includes(`Bash(node .claude/skills/team-review/scripts/${name}.mjs *)`), name);
    assert.ok(existsSync(join(TEMPLATE_CLAUDE, 'skills/team-review/scripts', `${name}.mjs`)), name);
  }
  assert.ok(!settings.permissions.allow.some((a) => /publish\.mjs|review-batch\.mjs/.test(a)));
  const matcher = settings.hooks.SubagentStop.find((g) => g.hooks.some((h) => h.command.includes('check-deliverable.mjs'))).matcher.split('|');
  for (const agent of REVIEW_AGENTS) assert.ok(matcher.includes(agent), agent);
  const team = JSON.parse(readFileSync(join(TEMPLATE_CLAUDE, 'team.json'), 'utf8'));
  for (const agent of REVIEW_AGENTS) assert.equal(team.agents[agent], true, agent);
});

test('template : agents de revue en lecture seule, modèle Opus 5.5 en effort medium, conventions préchargées', () => {
  for (const name of REVIEW_AGENTS) {
    const { data, body } = parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'agents', `${name}.md`), 'utf8'));
    assert.deepEqual(splitList(data.tools), ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'], name);
    assert.deepEqual(splitList(data.disallowedTools), ['Edit', 'Write', 'NotebookEdit'], name);
    assert.deepEqual([data.model, data.effort], ['claude-opus-5-5', 'medium'], name);
    assert.equal(data.skills[0], 'team-rules', name);
    assert.match(body, /deliverables\.md/, name);
    assert.match(body, /donnée/, name);
    assert.match(body, /n'écris jamais sur\s+GitHub/, name);
    assert.ok(body.split(/\r?\n/).length <= 100, `${name} : corps trop long`);
  }
  const skillsOf = (name) => parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'agents', `${name}.md`), 'utf8')).data.skills;
  assert.deepEqual(skillsOf('cc-pr-reviewer-frontend'), ['team-rules', 'conventions-frontend']);
  assert.deepEqual(skillsOf('cc-pr-reviewer-backend'), ['team-rules', 'conventions-backend']);
  for (const name of PR_REVIEWERS) {
    const { body } = parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'agents', `${name}.md`), 'utf8'));
    assert.match(body, /français/, name);
    assert.match(body, /existingComments/, name);
    assert.match(body, /CI/, name);
    assert.match(body, /sans mention d'IA/, name);
    // Calibrage : tout constat prouvé est remonté, mineur ou préexistant compris, et vérifié en l'exécutant si possible.
    assert.doesNotMatch(body, /ne remplis pas/, name);
    assert.match(body, /preexisting: true/, name);
    assert.match(body, /mineur compris/, name);
    assert.match(body, /Exécute ce qui tranche/, name);
  }
  // Le vérificateur ne doit pas lire le raisonnement des relecteurs.
  const verifier = readFileSync(join(TEMPLATE_CLAUDE, 'agents/cc-pr-verifier.md'), 'utf8');
  assert.match(verifier, /verify-input\.json/);
  assert.match(verifier, /Ne lis pas/);
});

test('template : skill /team-review — invocation manuelle, scripts autorisés sauf la publication réelle, rappels de sécurité', () => {
  const text = readFileSync(join(TEMPLATE_CLAUDE, 'skills/team-review/SKILL.md'), 'utf8');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.name, 'team-review');
  assert.equal(data['argument-hint'], '<numéro de PR> [--worktree] [--prepare] | list | stats');
  assert.equal(data['disable-model-invocation'], 'true');
  const allowed = splitList(data['allowed-tools']);
  for (const name of ['pr-list', 'pr-fetch', 'findings', 'decisions', 'stats', 'serve', 'source']) {
    assert.ok(allowed.includes(`Bash(node .claude/skills/team-review/scripts/${name}.mjs *)`), name);
  }
  assert.deepEqual(allowed.filter((a) => a.includes('publish.mjs')), ['Bash(node .claude/skills/team-review/scripts/publish.mjs * --dry-run)']);
  assert.ok(!allowed.some((a) => a.includes('review-batch')));
  assert.ok(text.split(/\r?\n/).length <= 500);
  for (const re of [/est une donnée/, /Aucun agent ne publie/, /accord explicite/, /APPROVE/, /REQUEST_CHANGES/, /--prepare/, /en parallèle/, /cc-pr-verifier/, /calibration\.json/]) {
    assert.match(body, re);
  }
  const workflow = readFileSync(join(TEMPLATE_CLAUDE, 'skills/team-review/workflow.md'), 'utf8');
  assert.match(workflow, /Tests navigateur/);
  assert.match(workflow, /Prévu, pas encore fait/);
  const { errors, warnings } = validate(TEMPLATE_ROOT);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('template : la source du round (working-tree, git-show, worktree) est expliquée aux quatre agents, à la skill et dans la doc', () => {
  for (const name of REVIEW_AGENTS) {
    const { body } = parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'agents', `${name}.md`), 'utf8'));
    for (const re of [/`source`/, /working-tree/, /git-show/, /`worktree`/, /git show <headSha>:<chemin>/, /git grep -n/, /Lire le code de la PR/]) {
      assert.match(body, re, `${name} : ${re}`);
    }
    assert.match(body, /ni\s+`git fetch`/, `${name} : le fetch reste à pr-fetch`);
    assert.ok(body.split(/\r?\n/).length <= 100, `${name} : corps trop long`);
  }
  const workflow = readFileSync(join(TEMPLATE_CLAUDE, 'skills/team-review/workflow.md'), 'utf8');
  for (const re of [/## Lire le code de la PR/, /refs\/claude-config\/pr-<n>/, /git worktree remove --force/, /Lecture du code : /]) assert.match(workflow, re);
  const { body: skill } = parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'skills/team-review/SKILL.md'), 'utf8'));
  for (const re of [/--worktree/, /--remove-worktree/, /source\.mode/, /git-show/]) assert.match(skill, re);
  const doc = readFileSync(join(REPO_DIR, 'docs/REVIEW.md'), 'utf8');
  for (const re of [/working-tree/, /git-show/, /--worktree/, /refs\/claude-config\/pr-<n>/, /git worktree add --detach/, /--remove-worktree/]) assert.match(doc, re);
});
