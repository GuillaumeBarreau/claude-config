#!/usr/bin/env node
// Crée un run /team de façon déterministe : identifiant unique, dates réelles, session,
// valeurs de .claude/team.json, contrôles recopiés. L'orchestrateur n'écrit plus le
// state.json initial à la main (une date d'exemple recopiée faussait les mesures).
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team/scripts/new-run.mjs --slug <slug> --track <quick|standard|full>
//        --session <id> [--title "<titre>"] [--issue <n>]
//
// Affiche l'identifiant du run (`.agent-runs/<id>/`). La demande se met ensuite dans
// `.agent-runs/<id>/request.md`.
// Sortie : 0 créé, 2 entrée invalide ou état refusé par check-state (rien n'est écrit).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkState, TRACKS } from './check-state.mjs';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SLUG = /^[a-z0-9][a-z0-9-]{0,48}$/;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** Renvoie { code, id, message }. */
export function newRun({ claudeDir = CLAUDE_DIR, slug, track, sessionId, title = '', issue = null, now = () => new Date() }) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    return { code: 2, message: `slug « ${slug} » invalide : minuscules, chiffres et tirets (${SLUG})` };
  }
  if (!TRACKS.includes(track)) return { code: 2, message: `piste « ${track} » invalide (${TRACKS.join(', ')})` };
  if (typeof sessionId !== 'string' || !sessionId.trim()) return { code: 2, message: 'identifiant de session obligatoire (--session)' };
  if (issue !== null && !(Number.isInteger(issue) && issue > 0)) return { code: 2, message: `issue « ${issue} » invalide` };

  let team = {};
  try {
    team = readJson(join(claudeDir, 'team.json'));
  } catch { /* sans team.json : planification seule, aucun contrôle */ }

  const at = now().toISOString();
  const runsDir = join(dirname(claudeDir), '.agent-runs');
  const base = `${at.slice(0, 10)}-${slug}`;
  let id = base;
  for (let n = 2; existsSync(join(runsDir, id)); n += 1) id = `${base}-${n}`;

  const template = readJson(join(claudeDir, 'skills', 'team', 'templates', 'state.json'));
  const pending = () => ({ status: 'pending', by: null, at: null, notes: '' });
  const state = {
    ...template,
    schemaVersion: 2,
    id,
    title: title || slug,
    track,
    status: 'qualifying',
    autonomy: team.autonomy === 'autonomous' ? 'autonomous' : 'supervised',
    sessionId,
    branch: null,
    baseBranch: typeof team.baseBranch === 'string' && team.baseBranch ? team.baseBranch : 'main',
    createdAt: at,
    updatedAt: at,
    gates: { plan: pending(), checks: pending(), review: pending(), delivery: pending() },
    openQuestions: [],
    answers: [],
    attempts: { clarification: 0 },
    limits: {
      maxAttempts: Number.isInteger(team.maxAttempts) ? team.maxAttempts : 2,
      maxClarificationRounds: Number.isInteger(team.maxClarificationRounds) ? team.maxClarificationRounds : 2,
    },
    planCheck: null,
    scope: null,
    ci: null,
    pr: null,
    prComments: null,
    tasks: [],
    checks: (Array.isArray(team.checks) ? team.checks : []).map((c) => ({
      name: c.name, command: c.command, required: c.required === true, status: 'not_run', at: null, summary: '',
    })),
    blockedReason: null,
    log: [{ at, actor: 'orchestrator', event: 'run_created', detail: `Piste ${track}` }],
  };
  if (issue !== null) state.issue = issue;

  const errors = checkState(state, Object.keys(team).length ? team : null);
  if (errors.length) return { code: 2, message: `état initial refusé par check-state : ${errors.join(' ; ')}` };
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return { code: 0, id, message: `run créé : .agent-runs/${id}/` };
}

function main(argv) {
  const args = argv.slice(2);
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const issue = value('--issue');
  const out = newRun({
    slug: value('--slug'),
    track: value('--track'),
    sessionId: value('--session'),
    title: value('--title') ?? '',
    issue: issue === undefined ? null : Number(issue),
  });
  if (out.code) {
    console.error(`erreur : ${out.message}`);
    console.error('Usage : node new-run.mjs --slug <slug> --track <quick|standard|full> --session <id> [--title "<titre>"] [--issue <n>]');
    return out.code;
  }
  console.log(out.id);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
