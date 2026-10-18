#!/usr/bin/env node
// Hook Stop : tant qu'un run /team de cette session est actif (executing, checking,
// reviewing, awaiting_ci), Claude ne s'arrête pas au milieu : il passe à l'étape
// suivante. Pour rendre la main, l'orchestrateur met d'abord le run dans un statut
// d'attente (blocked avec une raison, awaiting_input avec des questions,
// awaiting_delivery_approval).
//
// Garde-fou contre les boucles, fondé sur le progrès du run et non sur la seule
// relance : le hook mémorise l'empreinte (sha256) de state.json dans
// .agent-runs/<id>/.keep-running.json. Il relance tant que state.json a changé depuis
// la dernière relance ; si rien n'a bougé après MAX_RELAUNCHES_WITHOUT_PROGRESS
// relance(s) (stop_hook_active vrai), il laisse s'arrêter.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_DIR, readPayload } from './lib.mjs';

const ACTIVE = ['executing', 'checking', 'reviewing', 'awaiting_ci'];
export const MAX_RELAUNCHES_WITHOUT_PROGRESS = 1;
const MEMORY_FILE = '.keep-running.json';

/** Runs actifs de la session : [{ state, dir, digest }]. */
export function activeRuns(projectDir, sessionId) {
  const runsDir = join(projectDir, '.agent-runs');
  if (!sessionId || !existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
    const dir = join(runsDir, e.name);
    try {
      const raw = readFileSync(join(dir, 'state.json'), 'utf8');
      const state = JSON.parse(raw.replace(/^﻿/, ''));
      if (state.sessionId !== sessionId || !ACTIVE.includes(state.status)) return [];
      return [{ state, dir, digest: createHash('sha256').update(raw).digest('hex') }];
    } catch {
      return [];
    }
  });
}

function readMemory(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MEMORY_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Décision pure pour un run. memory = { digest, count } de la dernière relance.
 * Renvoie { relaunch, memory } (memory = nouvelle mémoire si relance).
 */
export function decide(digest, memory, stopHookActive) {
  const progressed = !memory || memory.digest !== digest;
  const count = Number.isInteger(memory?.count) ? memory.count : 0;
  if (!progressed && stopHookActive && count >= MAX_RELAUNCHES_WITHOUT_PROGRESS) return { relaunch: false, memory };
  return { relaunch: true, memory: { digest, count: progressed || !stopHookActive ? 1 : count + 1 } };
}

function main() {
  let payload;
  try {
    payload = readPayload();
  } catch {
    return; // Un hook Stop illisible ne doit pas empêcher de rendre la main.
  }
  const runs = activeRuns(process.env.CLAUDE_PROJECT_DIR || PROJECT_DIR, payload.session_id);
  const relaunched = runs.filter((run) => {
    const { relaunch, memory } = decide(run.digest, readMemory(run.dir), payload.stop_hook_active === true);
    if (relaunch) {
      try {
        writeFileSync(join(run.dir, MEMORY_FILE), `${JSON.stringify({ ...memory, at: new Date().toISOString() })}\n`);
      } catch {
        // Mémoire impossible à écrire : la relance suivante sera traitée comme un progrès,
        // mais stop_hook_active la limitera à une seule relance par arrêt.
        return !payload.stop_hook_active;
      }
    }
    return relaunch;
  });
  if (!relaunched.length) return;
  const list = relaunched.map((r) => `${r.state.id} (${r.state.status})`).join(', ');
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Run /team en cours : ${list}. Continue l'étape suivante du workflow sans attendre `
      + '(en awaiting_ci : relance ci-wait). Pour rendre la main, mets d\'abord le run en blocked '
      + '(avec blockedReason), awaiting_input (avec openQuestions) ou awaiting_delivery_approval.',
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
