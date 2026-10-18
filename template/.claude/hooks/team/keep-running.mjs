#!/usr/bin/env node
// Hook Stop : tant qu'un run /team de cette session est en exécution (executing,
// checking, reviewing), Claude ne s'arrête pas au milieu : il passe à l'étape suivante.
// Pour rendre la main, l'orchestrateur met d'abord le run dans un statut d'attente
// (blocked avec une raison, awaiting_input avec des questions,
// awaiting_delivery_approval).
//
// Garde-fou contre les boucles : une seule relance par arrêt (stop_hook_active).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_DIR, readPayload } from './lib.mjs';

const ACTIVE = ['executing', 'checking', 'reviewing'];

export function activeRuns(projectDir, sessionId) {
  const runsDir = join(projectDir, '.agent-runs');
  if (!sessionId || !existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
    try {
      const state = JSON.parse(readFileSync(join(runsDir, e.name, 'state.json'), 'utf8').replace(/^﻿/, ''));
      return state.sessionId === sessionId && ACTIVE.includes(state.status) ? [state] : [];
    } catch {
      return [];
    }
  });
}

function main() {
  let payload;
  try {
    payload = readPayload();
  } catch {
    return; // Un hook Stop illisible ne doit pas empêcher de rendre la main.
  }
  if (payload.stop_hook_active) return;
  const runs = activeRuns(process.env.CLAUDE_PROJECT_DIR || PROJECT_DIR, payload.session_id);
  if (!runs.length) return;
  const list = runs.map((r) => `${r.id} (${r.status})`).join(', ');
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Run /team en cours : ${list}. Continue l'étape suivante du workflow sans attendre. `
      + 'Pour rendre la main, mets d\'abord le run en blocked (avec blockedReason), awaiting_input '
      + '(avec openQuestions) ou awaiting_delivery_approval.',
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
