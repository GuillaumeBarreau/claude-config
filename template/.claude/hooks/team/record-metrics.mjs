#!/usr/bin/env node
// Hook de mesure, jamais bloquant (sortie 0 dans tous les cas, ajout seulement) :
// - PostToolUse sur Agent|Task, agents de l'équipe : une ligne « agent » dans
//   .agent-runs/<id>/metrics.jsonl (durée, appels d'outils, tokens, modèle, tâche) ;
// - Stop : une ligne « turn » (un tour de l'orchestrateur).
// Le run est celui de la session (sessionId === session_id) dont le statut n'est pas
// terminal. Lecture : node .claude/skills/team/scripts/metrics.mjs .agent-runs/<id>.

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AGENTS } from '../../skills/team/scripts/deliverable.mjs';
import { CLAUDE_DIR, PROJECT_DIR, readPayload } from './lib.mjs';

export const TEAM_AGENTS = AGENTS;
const TERMINAL = ['done', 'cancelled'];

export const projectDir = () => process.env.CLAUDE_PROJECT_DIR || PROJECT_DIR;

const readState = (dir) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8').replace(/^﻿/, ''));

/** Dossier du run non terminal de la session (le plus récemment mis à jour), ou null. */
export function findSessionRun(root, sessionId) {
  const runsDir = join(root, '.agent-runs');
  if (!sessionId || !existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
    try {
      const state = readState(join(runsDir, e.name));
      return state.sessionId === sessionId && !TERMINAL.includes(state.status)
        ? [{ dir: join(runsDir, e.name), updatedAt: String(state.updatedAt ?? '') }] : [];
    } catch {
      return [];
    }
  });
  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return runs[0]?.dir ?? null;
}

export function appendMetric(runDir, entry) {
  appendFileSync(join(runDir, 'metrics.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** Tâche dans la description d'un appel : « <agent> <Tn|spec|plan|consult|split> #<k> ». */
export function parseTask(description) {
  const m = String(description ?? '').match(/^\s*[\w-]+\s+([^\s#]+)\s+#\d+\s*$/);
  return m ? m[1] : null;
}

/** Modèle déclaré dans le frontmatter de l'agent (défaut quand l'appel n'en impose pas). */
function defaultModel(agent) {
  try {
    const text = readFileSync(join(CLAUDE_DIR, 'agents', `${agent}.md`), 'utf8');
    return text.match(/^model:\s*["']?([\w.-]+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

const numberOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function agentEntry(payload) {
  const input = payload.tool_input ?? {};
  const response = payload.tool_response ?? {};
  const agent = input.subagent_type;
  if (!TEAM_AGENTS.includes(agent)) return null;
  return {
    kind: 'agent',
    agent,
    task: parseTask(input.description),
    model: input.model || defaultModel(agent),
    durationMs: numberOr(response.totalDurationMs),
    toolUses: numberOr(response.totalToolUseCount),
    tokens: numberOr(response.totalTokens),
  };
}

function main() {
  const payload = readPayload();
  const event = payload.hook_event_name;
  const entry = event === 'Stop' ? { kind: 'turn' } : event === 'PostToolUse' ? agentEntry(payload) : null;
  if (!entry) return;
  const runDir = findSessionRun(projectDir(), payload.session_id);
  if (runDir) appendMetric(runDir, entry);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[record-metrics] mesure ignorée : ${err.message}\n`);
  }
}
