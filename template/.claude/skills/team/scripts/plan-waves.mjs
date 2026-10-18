#!/usr/bin/env node
// Regroupe les tâches restantes d'un run /team en « vagues » qui pourraient s'exécuter
// en parallèle : dépendances satisfaites, aucun fichier commun (files ∪ newFiles), et
// une tâche requiresHuman ou sans fichier connu toujours seule dans sa vague.
//
// INFORMATION SEULEMENT : l'exécution reste séquentielle (une tâche à la fois). Ce
// script mesure ce que le parallélisme rapporterait sur des plans réels ; voir
// docs/decisions/0006-backlog-lecons-parallelisme.md pour les conditions de sa mise
// en œuvre.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team/scripts/plan-waves.mjs .agent-runs/<id> [--json]
// Sortie : 0 (vagues affichées), 2 en cas d'erreur (run introuvable, JSON invalide).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Statuts dont on ne sortira pas sans intervention : leurs dépendants attendent.
const DEAD = ['blocked', 'failed'];

/** Chemin comparable : séparateurs « / », sans « ./ », insensible à la casse (Windows). */
export const normalizePath = (path) => String(path).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  .replace(/^(\.\/)+/, '').toLowerCase();

const list = (value) => (Array.isArray(value) ? value : []);
const filesOf = (task) => new Set([...list(task.files), ...list(task.newFiles)].map(normalizePath).filter(Boolean));

/**
 * @param tasks liste des tâches de state.json
 * @returns {{ waves: { tasks: string[], note: string }[], done: string[],
 *             unschedulable: { id: string, reason: string }[] }}
 */
export function planWaves(tasks) {
  const all = list(tasks).filter((t) => t && typeof t.id === 'string');
  const known = new Map(all.map((t) => [t.id, t]));
  const done = all.filter((t) => t.status === 'done').map((t) => t.id);
  const unschedulable = all.filter((t) => DEAD.includes(t.status))
    .map((t) => ({ id: t.id, reason: `statut ${t.status}` }));
  const satisfied = new Set(done);
  let pending = all.filter((t) => t.status !== 'done' && !DEAD.includes(t.status));
  const waves = [];

  for (;;) {
    const available = pending.filter((t) => list(t.dependsOn).every((d) => satisfied.has(d)));
    if (!available.length) break;
    const wave = [];
    const used = new Set();
    const solo = [];
    for (const task of available) {
      const files = filesOf(task);
      if (task.requiresHuman === true) {
        solo.push({ tasks: [task.id], note: 'requiresHuman : décision humaine, seule dans sa vague' });
      } else if (!files.size) {
        solo.push({ tasks: [task.id], note: 'aucun fichier prévu : périmètre inconnu, seule dans sa vague' });
      } else if ([...files].some((f) => used.has(f))) {
        continue; // fichier commun avec une tâche de la vague : vague suivante
      } else {
        wave.push(task.id);
        for (const f of files) used.add(f);
      }
    }
    const placed = [...wave, ...solo.map((s) => s.tasks[0])];
    if (wave.length) waves.push({ tasks: wave, note: '' });
    waves.push(...solo);
    for (const id of placed) satisfied.add(id);
    pending = pending.filter((t) => !satisfied.has(t.id));
  }

  for (const task of pending) {
    const missing = list(task.dependsOn).filter((d) => !satisfied.has(d));
    const unknown = missing.filter((d) => !known.has(d));
    const dead = missing.filter((d) => known.has(d) && DEAD.includes(known.get(d).status));
    let reason;
    if (unknown.length) reason = `dépendance inconnue : ${unknown.join(', ')}`;
    else if (dead.length) reason = `dépend de ${dead.map((d) => `${d} (${known.get(d).status})`).join(', ')}`;
    else reason = `cycle ou dépendance non planifiable : ${missing.join(', ')}`;
    unschedulable.push({ id: task.id, reason });
  }
  return { waves, done, unschedulable };
}

function format(result) {
  const lines = ['Vagues possibles (information seulement : l\'exécution reste séquentielle)'];
  if (!result.waves.length) lines.push('  aucune tâche à planifier');
  for (const [i, wave] of result.waves.entries()) {
    lines.push(`  Vague ${i + 1} : ${wave.tasks.join(', ')}${wave.note ? `  — ${wave.note}` : ''}`);
  }
  if (result.done.length) lines.push(`  Déjà faites : ${result.done.join(', ')}`);
  for (const u of result.unschedulable) lines.push(`  Non planifiable : ${u.id} — ${u.reason}`);
  const parallel = result.waves.filter((w) => w.tasks.length > 1).length;
  lines.push(`${result.waves.length} vague(s), dont ${parallel} avec plusieurs tâches.`);
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const runDir = args.find((a) => !a.startsWith('--'));
  if (!runDir) {
    console.error('Usage : node plan-waves.mjs .agent-runs/<id> [--json]');
    return 2;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(join(resolve(runDir), 'state.json'), 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.error(`erreur : state.json illisible — ${err.message}`);
    return 2;
  }
  const result = planWaves(state.tasks);
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : format(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
