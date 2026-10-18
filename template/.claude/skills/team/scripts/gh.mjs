// Outils communs à ci-wait.mjs et pr-comments.mjs : exécution de gh et git (injectable
// pour les tests, qui n'appellent jamais le vrai gh), lecture de leur JSON, et
// réouverture d'un run après livraison (contrat §2.7).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Erreur de gh ou de git (absent, non authentifié, dépôt inconnu) : sortie 2. */
export class GhError extends Error {}

/**
 * Exécuteur réel : exec(cmd, args) → { code, stdout, stderr }. Pas de shell : les
 * arguments passent tels quels, sous Windows compris (gh.exe, git.exe).
 */
export function createExec(cwd) {
  return (cmd, args) => {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (res.error) return { code: 127, stdout: '', stderr: `${cmd} : ${res.error.message}` };
    return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };
}

/** Lance la commande ; code ≠ 0 → GhError avec la fin de stderr. */
export function run(exec, cmd, args) {
  const res = exec(cmd, args);
  if (res.code !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new GhError(`${cmd} ${args.slice(0, 3).join(' ')} a échoué (code ${res.code}) : ${detail || 'aucun message'}`);
  }
  return res.stdout;
}

/**
 * Une ou plusieurs valeurs JSON mises bout à bout : `gh api --paginate` sur une liste
 * écrit un tableau par page (`[...][...]`). Renvoie la liste des valeurs.
 */
export function parseJsonValues(text) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') {
      if (depth++ === 0) start = i;
    } else if (c === ']' || c === '}') {
      if (--depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  if (depth !== 0 || (!values.length && text.trim())) throw new GhError('réponse JSON de gh illisible');
  return values;
}

export function runJson(exec, cmd, args) {
  const out = run(exec, cmd, args);
  try {
    return JSON.parse(out);
  } catch {
    throw new GhError(`${cmd} ${args.slice(0, 2).join(' ')} : réponse JSON illisible`);
  }
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
export const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

export function readTeam(claudeDir) {
  try {
    return readJson(join(claudeDir, 'team.json'));
  } catch {
    return {};
  }
}

export function addLog(state, at, actor, event, detail) {
  if (!Array.isArray(state.log)) state.log = [];
  state.log.push({ at, actor, event, detail });
}

/** Tâche corrective au format de state.json (origin ci ou pr-review, sans fichiers imposés). */
export function correctiveTask({ id, title, description, origin, files = [] }) {
  return {
    id,
    title,
    description,
    type: 'bug',
    priority: 'P0',
    complexity: 'S',
    origin,
    acceptanceCriteria: [],
    dependsOn: [],
    files,
    newFiles: [],
    agent: 'implementer',
    tests: [],
    risks: [],
    requiresHuman: false,
    status: 'ready',
    attempts: 0,
    validation: { checks: 'not_run', review: null, evidence: [] },
  };
}

/**
 * Rouvre un run livré (§2.7) : ajoute les tâches correctives (ready), remet les portes
 * checks, review et delivery à pending avec une note, repasse en executing sur la même
 * branche. Le nouveau push repasse donc par la porte 4. Modifie et renvoie state.
 */
export function reopenRun(state, tasks, reason, now = new Date().toISOString(), actor = 'orchestrator') {
  if (!Array.isArray(state.tasks)) state.tasks = [];
  const ids = new Set(state.tasks.map((t) => t && t.id));
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`tâche « ${task.id} » déjà présente dans le run`);
    state.tasks.push({ ...task, status: 'ready' });
  }
  for (const name of ['checks', 'review', 'delivery']) {
    state.gates[name] = { status: 'pending', by: null, at: null, notes: `Run rouvert : ${reason}` };
  }
  state.status = 'executing';
  state.blockedReason = null;
  state.updatedAt = now;
  addLog(state, now, actor, 'run_reopened', `${reason} (${tasks.map((t) => t.id).join(', ')})`);
  return state;
}
