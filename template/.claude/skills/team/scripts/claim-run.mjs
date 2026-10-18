#!/usr/bin/env node
// « /team reprendre <id> » depuis une nouvelle session : le run passe à cette session,
// pour que le hook keep-running (qui ne suit que les runs de sa session) relance bien
// l'orchestrateur. Appelé par la skill team avant même que le modèle lise la demande.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team/scripts/claim-run.mjs <mot> <id> <sessionId>
//   N'agit que si <mot> vaut « reprendre » ; sinon sans objet.
// Sortie : 0 (run repris, ou sans objet), 1 (run introuvable, état invalide, session
// absente).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkState } from './check-state.mjs';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT_DIR = dirname(CLAUDE_DIR);
const RUN_ID = /^[\w.-]+$/;

/** Renvoie l'état repris par sessionId (copie), ou l'état tel quel si déjà à elle. */
export function claimRun(state, sessionId, now = new Date().toISOString()) {
  if (state.sessionId === sessionId) return state;
  const next = structuredClone(state);
  next.sessionId = sessionId;
  next.updatedAt = now;
  if (!Array.isArray(next.log)) next.log = [];
  next.log.push({ at: now, actor: 'claim-run', event: 'run_resumed', detail: `session ${state.sessionId ?? '(aucune)'} → ${sessionId}` });
  return next;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

function main(argv) {
  const [word, id, sessionId] = argv.slice(2);
  if (word !== 'reprendre') return 0; // nouvelle demande : rien à reprendre
  if (!id || !RUN_ID.test(id) || id === '.' || id === '..') {
    console.log(`claim-run : identifiant de run invalide « ${id ?? ''} ».`);
    return 1;
  }
  if (!sessionId || !sessionId.trim()) {
    console.log('claim-run : identifiant de session absent, run non repris.');
    return 1;
  }
  const statePath = join(PROJECT_DIR, '.agent-runs', id, 'state.json');
  if (!existsSync(statePath)) {
    console.log(`claim-run : run « ${id} » introuvable (.agent-runs/${id}/state.json).`);
    return 1;
  }
  let state;
  let team = null;
  try {
    state = readJson(statePath);
    const teamPath = join(CLAUDE_DIR, 'team.json');
    if (existsSync(teamPath)) team = readJson(teamPath);
  } catch (err) {
    console.log(`claim-run : lecture ou JSON invalide — ${err.message}`);
    return 1;
  }
  const errors = checkState(state, team);
  if (errors.length) {
    console.log(`claim-run : state.json du run « ${id} » invalide, run non repris :`);
    for (const e of errors) console.log(`  - ${e}`);
    return 1;
  }
  const next = claimRun(state, sessionId);
  if (next === state) {
    console.log(`claim-run : run « ${id} » déjà suivi par cette session.`);
    return 0;
  }
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`claim-run : run « ${id} » repris par cette session (statut ${next.status}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
