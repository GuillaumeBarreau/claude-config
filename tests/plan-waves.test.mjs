import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { planWaves } from '../template/.claude/skills/team/scripts/plan-waves.mjs';
import { TEMPLATE_CLAUDE, tempDir, writeFile } from './helpers.mjs';

const SCRIPT = join(TEMPLATE_CLAUDE, 'skills/team/scripts/plan-waves.mjs');

const task = (id, files, extra = {}) => ({
  id, files, newFiles: [], dependsOn: [], requiresHuman: false, status: 'ready', ...extra,
});
const ids = (result) => result.waves.map((w) => w.tasks);

test('deux tâches indépendantes sans fichier commun : même vague', () => {
  const result = planWaves([task('T1', ['src/a.js']), task('T2', ['src/b.js'])]);
  assert.deepEqual(ids(result), [['T1', 'T2']]);
});

test('deux tâches partageant un fichier : vagues séparées (files ∪ newFiles, chemins normalisés)', () => {
  assert.deepEqual(ids(planWaves([task('T1', ['src/a.js']), task('T2', ['src/a.js'])])), [['T1'], ['T2']]);
  // Fichier nouveau de l'une, fichier existant de l'autre ; séparateurs et « ./ » différents.
  const mixed = planWaves([
    task('T1', [], { newFiles: ['./src/New.js'] }),
    task('T2', ['src\\new.js']),
    task('T3', ['src/c.js']),
  ]);
  assert.deepEqual(ids(mixed), [['T1', 'T3'], ['T2']]);
});

test('les dépendances sont respectées ; une tâche done compte comme satisfaite', () => {
  const result = planWaves([
    task('T1', ['a.js'], { status: 'done' }),
    task('T2', ['b.js'], { dependsOn: ['T1'] }),
    task('T3', ['c.js'], { dependsOn: ['T2'] }),
    task('T4', ['d.js'], { dependsOn: ['T1'] }),
  ]);
  assert.deepEqual(ids(result), [['T2', 'T4'], ['T3']]);
  assert.deepEqual(result.done, ['T1']);
});

test('tâche requiresHuman ou sans fichier : seule dans sa vague', () => {
  const result = planWaves([
    task('T1', ['a.js']),
    task('T2', ['package.json'], { requiresHuman: true }),
    task('CI1', []),
    task('T3', ['b.js']),
  ]);
  assert.deepEqual(ids(result), [['T1', 'T3'], ['T2'], ['CI1']]);
  assert.match(result.waves[1].note, /requiresHuman/);
  assert.match(result.waves[2].note, /aucun fichier/);
});

test('dépendance bloquée, échouée, inconnue ou cycle : tâche non planifiable, avec la raison', () => {
  const result = planWaves([
    task('T1', ['a.js'], { status: 'failed' }),
    task('T2', ['b.js'], { dependsOn: ['T1'] }),
    task('T3', ['c.js'], { dependsOn: ['T9'] }),
    task('T4', ['d.js'], { dependsOn: ['T5'] }),
    task('T5', ['e.js'], { dependsOn: ['T4'] }),
    task('T6', ['f.js']),
  ]);
  assert.deepEqual(ids(result), [['T6']]);
  const reasons = Object.fromEntries(result.unschedulable.map((u) => [u.id, u.reason]));
  assert.match(reasons.T1, /failed/);
  assert.match(reasons.T2, /T1/);
  assert.match(reasons.T3, /T9/);
  assert.match(reasons.T4, /cycle|T5/);
  assert.match(reasons.T5, /cycle|T4/);
});

test('CLI : --json sur un run, et erreur sans state.json', () => {
  const runDir = join(tempDir(), '.agent-runs', 'r1');
  writeFile(join(runDir, 'state.json'), JSON.stringify({
    id: 'r1', tasks: [task('T1', ['a.js']), task('T2', ['a.js'])],
  }));
  const ok = spawnSync(process.execPath, [SCRIPT, runDir, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).waves.map((w) => w.tasks), [['T1'], ['T2']]);

  const text = spawnSync(process.execPath, [SCRIPT, runDir], { encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Vague 1 : T1/);
  assert.match(text.stdout, /information/i);

  const missing = spawnSync(process.execPath, [SCRIPT, join(runDir, 'absent')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});
