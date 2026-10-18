#!/usr/bin/env node
// Hook SubagentStop (planner, implementer, code-reviewer) : le message final de l'agent
// doit se terminer par un livrable JSON conforme à skills/team/deliverables.md.
// - Invalide : l'agent est renvoyé au travail avec les erreurs (decision: block), une
//   seule fois (stop_hook_active) ; au second échec il s'arrête et le rejet est mesuré.
// - Valide, dans un run existant : copie dans deliverables/<NNN>-<agent>[-<tâche>].json
//   et, pour code-reviewer, dans review-<tâche>-<k>.json (review-<k>.json sans tâche).
// Ce hook n'écrit jamais state.json : c'est le rôle de l'orchestrateur.
// Entrée illisible : on laisse l'agent s'arrêter (un Stop qui bloque boucle).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SCHEMA_HINT, extractDeliverable, validateDeliverable } from '../../skills/team/scripts/deliverable.mjs';
import { readPayload } from './lib.mjs';
import { TEAM_AGENTS, appendMetric, findSessionRun, projectDir } from './record-metrics.mjs';

const RUN_ID = /^[\w.-]+$/;
const safe = (v) => String(v).replace(/[^\w.-]/g, '_');

function nextIndex(dir, pattern) {
  const used = readdirSync(dir).map((f) => f.match(pattern)).filter(Boolean).map((m) => Number(m[1]));
  return used.length ? Math.max(...used) + 1 : 1;
}

/** Enregistre un livrable valide dans le dossier du run ; renvoie les fichiers écrits. */
export function recordDeliverable(runDir, agent, data) {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const task = typeof data.task === 'string' && data.task ? safe(data.task) : null;
  const deliverables = join(runDir, 'deliverables');
  mkdirSync(deliverables, { recursive: true });
  const n = String(nextIndex(deliverables, /^(\d+)-/)).padStart(3, '0');
  const written = [join(deliverables, `${n}-${agent}${task ? `-${task}` : ''}.json`)];
  if (agent === 'code-reviewer') {
    const prefix = task ? `review-${task}-` : 'review-';
    const pattern = new RegExp(`^${prefix.replace(/[.]/g, '\\.')}(\\d+)\\.json$`);
    written.push(join(runDir, `${prefix}${nextIndex(runDir, pattern)}.json`));
  }
  for (const file of written) writeFileSync(file, content);
  return written;
}

function main() {
  let payload;
  try {
    payload = readPayload();
  } catch (err) {
    process.stderr.write(`[check-deliverable] entrée illisible, livrable non vérifié (${err.message})\n`);
    return;
  }
  const agent = payload.agent_type;
  if (!TEAM_AGENTS.includes(agent)) return;
  const root = projectDir();

  const { data, error } = extractDeliverable(payload.last_assistant_message);
  const errors = error ? [error] : validateDeliverable(data, agent);
  const runId = data && typeof data.run === 'string' && RUN_ID.test(data.run) ? data.run : null;
  const runDir = runId && existsSync(join(root, '.agent-runs', runId, 'state.json')) ? join(root, '.agent-runs', runId) : null;

  if (errors.length) {
    const target = runDir ?? findSessionRun(root, payload.session_id);
    if (target) appendMetric(target, { kind: 'deliverable_rejected', agent, final: Boolean(payload.stop_hook_active) });
    const list = errors.map((e) => `- ${e}`).join('\n');
    if (payload.stop_hook_active) {
      process.stderr.write(`[check-deliverable] livrable ${agent} toujours invalide, arrêt accepté :\n${list}\n`);
      return;
    }
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `Livrable ${agent} invalide :\n${list}\n${SCHEMA_HINT}`,
    }));
    return;
  }
  if (runId && !runDir) {
    process.stderr.write(`[check-deliverable] run « ${runId} » introuvable : livrable non enregistré\n`);
    return;
  }
  if (runDir) recordDeliverable(runDir, agent, data);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[check-deliverable] erreur inattendue, arrêt accepté : ${err.message}\n`);
  }
}
