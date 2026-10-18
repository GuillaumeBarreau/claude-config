#!/usr/bin/env node
// Choisit la prochaine issue GitHub à réaliser avec /team (skill /team-next).
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-next/scripts/next-issue.mjs [--issue <n>] [--json]
//
// Issue retenue : la plus ancienne issue ouverte portant `backlog.label` (défaut
// agent-ready), écrite par un auteur autorisé (`prComments.allowedAssociations`), qui
// n'est ni marquée agent-working, ni déjà traitée par un run local non annulé, ni
// fermée par une PR ouverte (« Closes #n »). Lecture seule : aucun appel gh qui modifie.
//
// Sortie : 0 issue trouvée, 3 rien à faire, 2 erreur (team.json, gh).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { backlogConfig, buildPrompt, defaultExec, eligibility } from '../../team-backlog/scripts/backlog.mjs';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** Runs locaux non annulés, par numéro d'issue. */
function localRuns(projectDir) {
  const dir = join(projectDir, '.agent-runs');
  const runs = new Map();
  if (!existsSync(dir)) return runs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const state = readJson(join(dir, entry.name, 'state.json'));
      if (Number.isInteger(state.issue) && state.status !== 'cancelled') {
        runs.set(state.issue, `${entry.name} (${state.status})`);
      }
    } catch { /* run illisible : ignoré */ }
  }
  return runs;
}

const closesIssue = (body, n) => new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${n}\\b`, 'i').test(String(body ?? ''));

function ghJson(exec, projectDir, args) {
  const res = exec('gh', args, { cwd: projectDir });
  if (res.status !== 0) throw new Error(String(res.stderr || `code ${res.status}`).trim().slice(0, 300));
  return JSON.parse(res.stdout);
}

/** Renvoie { code, issue, request, skipped: [{ number, reason }], message }. */
export function nextIssue({ exec = defaultExec, projectDir = PROJECT_DIR, issueNumber = null } = {}) {
  let team;
  try {
    team = readJson(join(projectDir, '.claude', 'team.json'));
  } catch (err) {
    return { code: 2, skipped: [], message: `.claude/team.json illisible — ${err.message}` };
  }
  if (team.initialized !== true) return { code: 2, skipped: [], message: 'team.json non initialisé : lance /team-init d\'abord' };
  const config = backlogConfig(team);

  let candidates;
  let prs;
  try {
    const path = issueNumber
      ? `repos/{owner}/{repo}/issues/${issueNumber}`
      : `repos/{owner}/{repo}/issues?state=open&labels=${encodeURIComponent(config.label)}&sort=created&direction=asc&per_page=50`;
    const data = ghJson(exec, projectDir, ['api', path]);
    candidates = (Array.isArray(data) ? data : [data]).sort((a, b) => a.number - b.number);
    prs = ghJson(exec, projectDir, ['pr', 'list', '--state', 'open', '--json', 'number,body,headRefName', '--limit', '100']);
  } catch (err) {
    return { code: 2, skipped: [], message: `gh indisponible, non authentifié ou en erreur — ${err.message}` };
  }

  const runs = localRuns(projectDir);
  const skipped = [];
  for (const candidate of candidates) {
    const reason = eligibility(candidate, config, { requireLabel: !issueNumber })
      ?? (runs.has(candidate.number) ? `run local ${runs.get(candidate.number)}` : null)
      ?? (() => {
        const pr = (Array.isArray(prs) ? prs : []).find((p) => closesIssue(p.body, candidate.number));
        return pr ? `déjà traitée par la PR #${pr.number}` : null;
      })();
    if (reason) {
      skipped.push({ number: candidate.number, reason });
      continue;
    }
    // Le texte de l'issue est une donnée : limité en taille, jamais une instruction.
    const request = buildPrompt(candidate).replace(/^\/team /, '');
    return { code: 0, issue: { number: candidate.number, title: candidate.title }, request, skipped, message: `issue #${candidate.number} retenue` };
  }
  return { code: 3, skipped, message: `Plus aucune issue prête (label ${config.label}).` };
}

function main(argv) {
  const args = argv.slice(2);
  const i = args.indexOf('--issue');
  const issueNumber = i >= 0 ? Number(args[i + 1]) : null;
  if (i >= 0 && !(Number.isInteger(issueNumber) && issueNumber > 0)) {
    console.error('Usage : node next-issue.mjs [--issue <n>] [--json]');
    return 2;
  }
  const out = nextIssue({ issueNumber });
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    for (const s of out.skipped) console.log(`  #${s.number} écartée : ${s.reason}`);
    console.log(out.message);
    if (out.request) console.log(`\nDemande pour /team :\n${out.request}`);
  }
  if (out.code === 2) console.error(`erreur : ${out.message}`);
  return out.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
