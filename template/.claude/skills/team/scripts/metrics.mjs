#!/usr/bin/env node
// Résume les mesures d'un run (metrics.jsonl, écrit par les hooks record-metrics et
// check-deliverable) : durée murale, tours de l'orchestrateur, coût par agent et par
// tâche. Information seulement : rien n'est modifié.
//
// Usage : node metrics.mjs .agent-runs/<id> [--json]
// Sortie : 0, ou 2 si le run est introuvable.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Lignes valides de metrics.jsonl (les lignes abîmées sont ignorées). */
export function readMetrics(runDir) {
  const path = join(runDir, 'metrics.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line) => {
    try {
      const entry = line.trim() ? JSON.parse(line) : null;
      return entry && typeof entry === 'object' ? [entry] : [];
    } catch {
      return [];
    }
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function summarize(state, lines) {
  const times = lines.map((l) => Date.parse(l.at)).filter((t) => !Number.isNaN(t));
  const start = Date.parse(state?.createdAt ?? '');
  const from = Number.isNaN(start) ? Math.min(...times) : start;
  const wallMs = times.length ? Math.max(0, Math.max(...times) - from) : 0;

  const byAgent = {};
  const byTask = {};
  const agentOf = (name) => (byAgent[name] ??= { calls: 0, durationMs: 0, toolUses: 0, tokens: 0, rejections: 0 });
  let turns = 0;
  for (const l of lines) {
    if (l.kind === 'turn') turns += 1;
    if (l.kind === 'deliverable_rejected' && l.agent) agentOf(l.agent).rejections += 1;
    if (l.kind !== 'agent' || !l.agent) continue;
    const a = agentOf(l.agent);
    a.calls += 1;
    a.durationMs += num(l.durationMs);
    a.toolUses += num(l.toolUses);
    a.tokens += num(l.tokens);
    if (!l.task) continue;
    const t = (byTask[l.task] ??= { implementerCalls: 0, models: [] });
    if (l.agent === 'implementer') t.implementerCalls += 1;
    if (l.model && !t.models.includes(l.model)) t.models.push(l.model);
  }
  return { run: state?.id ?? null, wallMs, turns, byAgent, byTask };
}

const minutes = (ms) => `${(ms / 60000).toFixed(1)} min`;

function format(s) {
  const out = [`Run ${s.run ?? '?'} : ${minutes(s.wallMs)} (durée murale), ${s.turns} tour(s) de l'orchestrateur`];
  const agents = Object.entries(s.byAgent);
  if (!agents.length) out.push('Aucune mesure d\'agent.');
  for (const [name, a] of agents) {
    out.push(`- ${name} : ${a.calls} appel(s), ${minutes(a.durationMs)}, ${a.toolUses} outil(s), ${a.tokens} tokens, ${a.rejections} livrable(s) rejeté(s)`);
  }
  for (const [task, t] of Object.entries(s.byTask)) {
    out.push(`- ${task} : ${t.implementerCalls} appel(s) implementer, modèles ${t.models.join(', ') || '—'}`);
  }
  return out.join('\n');
}

function main(argv) {
  const runDir = argv[2];
  if (!runDir || !existsSync(join(runDir, 'state.json'))) {
    console.error(`usage : node metrics.mjs .agent-runs/<id> [--json] — run introuvable : ${runDir ?? '(aucun)'}`);
    return 2;
  }
  let state = null;
  try {
    state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.error(`state.json illisible : ${err.message}`);
    return 2;
  }
  const summary = summarize(state, readMetrics(runDir));
  console.log(argv.includes('--json') ? JSON.stringify(summary, null, 2) : format(summary));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
