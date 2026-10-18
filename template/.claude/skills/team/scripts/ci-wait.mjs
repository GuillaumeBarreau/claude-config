#!/usr/bin/env node
// Attend le résultat de la CI GitHub Actions après le push d'un run /team et
// l'enregistre dans state.json (objet « ci »). Le statut vient de gh, jamais de ce
// qu'un agent affirme.
//
// Usage (depuis la racine du projet, après le push accordé à la porte 4) :
//   node .claude/skills/team/scripts/ci-wait.mjs .agent-runs/<id> [--max-wait 540] [--interval 20] [--create-task]
//
// - Entrée : statut awaiting_delivery_approval avec gates.delivery passed, ou
//   awaiting_ci (reprise). Le run passe en awaiting_ci ; SHA = git rev-parse <branch>.
// - Interroge `gh run list` toutes les --interval secondes, au plus --max-wait secondes
//   par appel (sous le délai de 10 min d'un appel Bash). Pas de `gh run watch`.
// - Aucun workflow pour ce SHA après 120 s → ci.status « n/a ». success, skipped et
//   neutral → passed ; toute autre conclusion → failed.
// - Échec : `gh run view <id> --log-failed` dans ci/<id>.log (fin, ≤ 200 Ko). Avec
//   --create-task et des tours restants (team.json ci.maxFixRounds, défaut 2) : tâche
//   CI<n> et run rouvert (executing) ; tours épuisés → blocked. Sans --create-task, le
//   run reste awaiting_ci avec ci.status failed.
// - Au-delà de ci.timeoutMinutes (défaut 30) depuis le début de l'attente → blocked.
// - team.json ci.enabled à false → sans objet, rien n'est modifié.
// Sortie : 0 passed ou n/a (run done), 1 failed ou blocked, 3 en attente (relancer la
// même commande), 2 erreur (gh absent ou non authentifié, run incompatible).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkState } from './check-state.mjs';
import {
  CLAUDE_DIR, GhError, addLog, correctiveTask, createExec, readJson, readTeam, reopenRun, run, runJson, writeJson,
} from './gh.mjs';

const ACTOR = 'ci-wait';
const GRACE_S = 120;
const MAX_LOG_BYTES = 200 * 1024;
const PASSING = ['success', 'skipped', 'neutral'];
const DEFAULTS = { enabled: true, timeoutMinutes: 30, maxFixRounds: 2 };
const RUN_FIELDS = 'databaseId,headSha,status,conclusion,workflowName,url';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const iso = (ms) => new Date(ms).toISOString();

function writeFailedLog(exec, runDir, runId) {
  const rel = `ci/${runId}.log`;
  let content;
  const res = exec('gh', ['run', 'view', String(runId), '--log-failed']);
  if (res.code === 0) content = Buffer.from(res.stdout ?? '', 'utf8');
  else content = Buffer.from(`[ci-wait] gh run view ${runId} --log-failed a échoué (code ${res.code}) : ${res.stderr ?? ''}\n`, 'utf8');
  if (content.length > MAX_LOG_BYTES) {
    const header = Buffer.from(`[ci-wait] journal tronqué : ${content.length} octets, fin conservée\n`, 'utf8');
    content = Buffer.concat([header, content.subarray(content.length - (MAX_LOG_BYTES - header.length))]);
  }
  mkdirSync(join(runDir, 'ci'), { recursive: true });
  writeFileSync(join(runDir, rel), content);
  return rel;
}

function nextTaskId(state, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  const used = (state.tasks ?? []).map((t) => t && re.exec(t.id)).filter(Boolean).map((m) => Number(m[1]));
  return `${prefix}${used.length ? Math.max(...used) + 1 : 1}`;
}

/**
 * Renvoie { code, message, state, stateErrors }. Écrit state.json sauf sur erreur (2).
 * exec, now et sleep sont injectables (tests : réponses gh enregistrées, horloge simulée).
 */
export function ciWait({
  runDir, claudeDir = CLAUDE_DIR, exec, now = Date.now, sleep = sleepSync,
  maxWaitS = 540, intervalS = 20, createTask = false,
}) {
  const team = readTeam(claudeDir);
  const config = { ...DEFAULTS, ...(team.ci ?? {}) };
  if (config.enabled === false) return { code: 0, message: 'CI désactivée (team.json ci.enabled) : sans objet' };

  const statePath = join(runDir, 'state.json');
  const state = readJson(statePath);
  const delivered = state.status === 'awaiting_delivery_approval' && state.gates?.delivery?.status === 'passed';
  if (!delivered && state.status !== 'awaiting_ci') {
    return { code: 2, message: `statut « ${state.status} » : ci-wait suit un push accordé (awaiting_delivery_approval avec porte livraison passed, ou awaiting_ci)` };
  }
  if (!state.branch) return { code: 2, message: 'state.json : « branch » absent' };
  exec = exec ?? createExec(dirname(claudeDir));

  try {
    const sha = run(exec, 'git', ['rev-parse', state.branch]).trim();
    const start = now();
    // Nouveau SHA (premier passage ou nouveau push après correction) : nouvelle attente,
    // les tours de correction se cumulent.
    if (!state.ci || state.ci.sha !== sha || state.ci.status !== 'pending') {
      state.ci = { status: 'pending', sha, startedAt: iso(start), checkedAt: null, rounds: state.ci?.rounds ?? 0, runs: [] };
    }
    state.status = 'awaiting_ci';
    if (!state.pr) {
      const pr = exec('gh', ['pr', 'view', state.branch, '--json', 'number,url']);
      if (pr.code === 0) {
        try {
          const { number, url } = JSON.parse(pr.stdout);
          state.pr = { number, url };
        } catch { /* PR illisible : on réessaiera au prochain passage */ }
      }
    }

    const startedAt = Date.parse(state.ci.startedAt);
    const deadline = start + maxWaitS * 1000;
    let outcome = null;
    let runs = [];
    for (;;) {
      const all = runJson(exec, 'gh', ['run', 'list', '--branch', state.branch, '--json', RUN_FIELDS, '--limit', '50']);
      runs = (Array.isArray(all) ? all : []).filter((r) => r.headSha === sha);
      const t = now();
      state.ci.checkedAt = iso(t);
      if (!runs.length && t - startedAt >= GRACE_S * 1000) outcome = 'n/a';
      else if (runs.length && runs.every((r) => r.status === 'completed')) {
        outcome = runs.every((r) => PASSING.includes(r.conclusion)) ? 'passed' : 'failed';
      } else if (t - startedAt > config.timeoutMinutes * 60_000) outcome = 'timeout';
      if (outcome || t + intervalS * 1000 > deadline) break;
      sleep(intervalS * 1000);
    }

    const at = state.ci.checkedAt;
    state.updatedAt = at;
    state.ci.runs = runs.map((r) => ({
      id: r.databaseId,
      name: r.workflowName,
      conclusion: r.status === 'completed' ? r.conclusion : r.status,
      url: r.url,
      log: null,
    }));
    let code;
    let message;
    if (!outcome) {
      code = 3;
      message = `CI en cours pour ${sha.slice(0, 7)} (${runs.length} workflow(s)) : relance la même commande`;
    } else if (outcome === 'passed' || outcome === 'n/a') {
      state.ci.status = outcome;
      state.status = 'done';
      addLog(state, at, ACTOR, 'ci_passed', outcome === 'n/a' ? `aucun workflow pour ${sha.slice(0, 7)} (n/a)` : `${runs.length} workflow(s) réussi(s)`);
      code = 0;
      message = outcome === 'n/a' ? 'Aucun workflow de CI pour ce commit : ci n/a, run done' : 'CI réussie : run done';
    } else if (outcome === 'timeout') {
      state.status = 'blocked';
      state.blockedReason = `CI : délai de ${config.timeoutMinutes} min dépassé sans résultat pour ${sha.slice(0, 7)}`;
      addLog(state, at, ACTOR, 'ci_failed', state.blockedReason);
      code = 1;
      message = state.blockedReason;
    } else {
      state.ci.status = 'failed';
      const failed = state.ci.runs.filter((r) => !PASSING.includes(r.conclusion));
      for (const r of failed) r.log = writeFailedLog(exec, runDir, r.id);
      const summary = failed.map((r) => `${r.name} (${r.conclusion})`).join(', ');
      addLog(state, at, ACTOR, 'ci_failed', summary);
      code = 1;
      message = `CI en échec : ${summary}`;
      if (createTask) {
        if (state.ci.rounds < config.maxFixRounds) {
          state.ci.rounds += 1;
          const id = nextTaskId(state, 'CI');
          const logs = failed.map((r) => `.agent-runs/${state.id}/${r.log} (${r.name}, ${r.url})`).join(' ; ');
          const task = correctiveTask({
            id,
            origin: 'ci',
            title: `Corriger la CI en échec (${failed.map((r) => r.name).join(', ')})`,
            description: `La CI a échoué sur ${sha.slice(0, 7)}. Journaux : ${logs}. Trouver la cause dans le code ; `
              + 'ne pas modifier les workflows de CI sans accord.',
          });
          addLog(state, at, ACTOR, 'ci_task_created', `${id} (tour ${state.ci.rounds}/${config.maxFixRounds})`);
          reopenRun(state, [task], `CI en échec (${summary})`, at, ACTOR);
          message += ` → tâche ${id} créée, run rouvert`;
        } else {
          state.status = 'blocked';
          state.blockedReason = `CI en échec après ${config.maxFixRounds} tour(s) de correction : ${summary}`;
          message = state.blockedReason;
        }
      }
    }
    writeJson(statePath, state);
    return { code, message, state, stateErrors: checkState(state, team) };
  } catch (err) {
    if (err instanceof GhError) return { code: 2, message: err.message };
    throw err;
  }
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} attend un nombre > 0`);
  return value;
}

function main(argv) {
  const args = argv.slice(2);
  const runDir = args.find((a, i) => !a.startsWith('--') && !['--max-wait', '--interval'].includes(args[i - 1]));
  if (!runDir) {
    console.error('Usage : node ci-wait.mjs .agent-runs/<id> [--max-wait 540] [--interval 20] [--create-task]');
    return 2;
  }
  let out;
  try {
    out = ciWait({
      runDir: resolve(runDir),
      maxWaitS: option(args, '--max-wait', 540),
      intervalS: option(args, '--interval', 20),
      createTask: args.includes('--create-task'),
    });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 2;
  }
  (out.code === 2 ? console.error : console.log)(out.code === 2 ? `erreur : ${out.message}` : out.message);
  for (const r of out.state?.ci?.runs ?? []) {
    console.log(`  ${String(r.conclusion).padEnd(12)} ${r.name}  ${r.url}${r.log ? `\n    journal : ${join(runDir, r.log)}` : ''}`);
  }
  for (const e of out.stateErrors ?? []) console.error(`state.json : ${e}`);
  return out.stateErrors?.length ? 2 : out.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
