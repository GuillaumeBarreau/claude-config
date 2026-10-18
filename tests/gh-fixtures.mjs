// Outils des tests de ci-wait et pr-comments : projet temporaire avec un run livré,
// exécuteur gh/git simulé qui rejoue les réponses enregistrées de tests/fixtures/gh/.
// Aucun test n'appelle le vrai gh ni le réseau.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gh');
export const SHA = '1111111111111111111111111111111111111111';
export const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/** Run standard livré : toutes les portes validées, une tâche done, porte 4 accordée. */
export function deliveredState(overrides = {}) {
  const at = '2026-10-18T10:00:00Z';
  return {
    id: 'r1',
    title: 'Export CSV',
    track: 'standard',
    status: 'awaiting_delivery_approval',
    autonomy: 'supervised',
    sessionId: null,
    branch: 'team/r1',
    baseBranch: 'main',
    createdAt: at,
    updatedAt: at,
    gates: {
      plan: { status: 'passed', by: 'user', at, notes: '' },
      checks: { status: 'passed', by: 'run-checks', at, notes: '' },
      review: { status: 'passed', by: 'orchestrator', at, notes: '' },
      delivery: { status: 'passed', by: 'user', at, notes: '' },
    },
    openQuestions: [],
    answers: [],
    attempts: { clarification: 0 },
    limits: { maxAttempts: 2, maxClarificationRounds: 2 },
    tasks: [{
      id: 'T1', title: 'Export', description: 'Exporter en CSV.', type: 'feature', priority: 'P1', complexity: 'S',
      acceptanceCriteria: ['AC1'], dependsOn: [], files: ['src/export.js'], agent: 'implementer', tests: [], risks: [],
      requiresHuman: false, status: 'done', attempts: 1, validation: { checks: 'passed', review: 'approve', evidence: [] },
    }],
    checks: [{ name: 'tests', command: 'npm test', required: true, status: 'passed', at, summary: '' }],
    blockedReason: null,
    log: [{ at, actor: 'orchestrator', event: 'run_created', detail: '' }],
    ...overrides,
  };
}

/** Projet temporaire : .claude/team.json, .agent-runs/r1/state.json, src/export.js. */
export function makeProject({ state = deliveredState(), team = {} } = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'claude-config-gh-'));
  const claudeDir = join(projectDir, '.claude');
  write(join(claudeDir, 'team.json'), JSON.stringify({
    initialized: true, baseBranch: 'main', maxAttempts: 2, maxClarificationRounds: 2,
    checks: [{ name: 'tests', command: 'npm test', required: true }], ...team,
  }));
  const runDir = join(projectDir, '.agent-runs', 'r1');
  write(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  write(join(projectDir, 'src', 'export.js'), 'export {};\n');
  return { projectDir, claudeDir, runDir, statePath: join(runDir, 'state.json') };
}

export const readState = (runDir) => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));

/**
 * Exécuteur simulé : `routes` associe un préfixe de commande (« gh run list ») à une
 * réponse { code, stdout, stderr } ou à une fonction qui la renvoie. Toute commande
 * non prévue échoue le test. `calls` garde chaque appel.
 */
export function fakeExec(routes) {
  const calls = [];
  const exec = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    // Le préfixe le plus long l'emporte (« gh run view 9101 » avant « gh run view »).
    const key = Object.keys(routes).filter((prefix) => line.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`commande non prévue par le test : ${line}`);
    const res = typeof routes[key] === 'function' ? routes[key](line) : routes[key];
    return { code: 0, stdout: '', stderr: '', ...res };
  };
  return { exec, calls };
}

/** Horloge simulée : sleep avance le temps sans attendre. */
export function fakeClock(start = Date.parse('2026-10-18T12:00:00Z')) {
  let t = start;
  return { now: () => t, sleep: (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}
