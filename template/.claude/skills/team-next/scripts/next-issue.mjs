#!/usr/bin/env node
// Choisit la prochaine issue GitHub à réaliser avec /team (skill /team-next).
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-next/scripts/next-issue.mjs [--issue <n>] [--json]
//
// Issue retenue : parmi les issues ouvertes portant `backlog.label` (défaut agent-ready),
// écrites par un auteur autorisé (`prComments.allowedAssociations`), ni marquées
// agent-working, ni déjà traitées par un run local non annulé, ni fermées par une PR
// ouverte (« Closes #n »), celles qui sont prêtes : les trois rubriques minimales du
// modèle d'issue (Objectif, Comportement attendu ou critères, Hors périmètre) et aucune
// dépendance « Dépend de #n » ouverte ni en cycle. On prend la plus prioritaire
// (`backlog.priorityLabels`, défaut P0 / P1 / P2 ; sans label en dernier), puis la plus
// ancienne. Les issues écartées sont listées avec leur raison ; une dépendance inconnue ou
// illisible n'écarte pas l'issue mais produit un avertissement (`warnings`, visant l'issue
// nommée, retenue ou non ; au plus 5 par issue et 20 au total, ceux de l'issue retenue
// d'abord, les autres comptés dans `warningsOmitted`). Au plus 20 dépendances sont lues
// (gh api … GET).
// Lecture seule : aucun appel gh qui modifie.
//
// Sortie : 0 issue trouvée, 3 rien à faire, 2 erreur (team.json, gh).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { backlogConfig, buildPrompt, defaultExec, eligibility } from '../../team-backlog/scripts/backlog.mjs';
import { orderIssues, resolveDependencyStates } from '../../team-backlog/scripts/issue-queue.mjs';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MAX_WARNINGS_PER_ISSUE = 5;
const MAX_WARNINGS = 20;
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

/**
 * Borne les avertissements (ils viennent du texte des issues) : ceux de l'issue retenue
 * d'abord, au plus MAX_WARNINGS_PER_ISSUE par issue et MAX_WARNINGS au total.
 * @returns {{ warnings: { number, message }[], warningsOmitted: number }}
 */
function limitWarnings(all, chosenNumber) {
  const ordered = [...all.filter((w) => w.number === chosenNumber), ...all.filter((w) => w.number !== chosenNumber)];
  const perIssue = new Map();
  const warnings = [];
  for (const w of ordered) {
    const count = perIssue.get(w.number) ?? 0;
    if (count >= MAX_WARNINGS_PER_ISSUE || warnings.length >= MAX_WARNINGS) continue;
    perIssue.set(w.number, count + 1);
    warnings.push(w);
  }
  return { warnings, warningsOmitted: all.length - warnings.length };
}

/** Renvoie { code, issue, request, skipped: [{ number, reason }], warnings: [{ number, message }], warningsOmitted, message }. */
export function nextIssue({ exec = defaultExec, projectDir = PROJECT_DIR, issueNumber = null } = {}) {
  let team;
  try {
    team = readJson(join(projectDir, '.claude', 'team.json'));
  } catch (err) {
    return { code: 2, skipped: [], warnings: [], warningsOmitted: 0, message: `.claude/team.json illisible — ${err.message}` };
  }
  if (team.initialized !== true) return { code: 2, skipped: [], warnings: [], warningsOmitted: 0, message: 'team.json non initialisé : lance /team-init d\'abord' };
  const config = backlogConfig(team);

  let candidates;
  let prs;
  try {
    const path = issueNumber
      ? `repos/{owner}/{repo}/issues/${issueNumber}`
      : `repos/{owner}/{repo}/issues?state=open&labels=${encodeURIComponent(config.label)}&sort=created&direction=asc&per_page=50`;
    const data = ghJson(exec, projectDir, ['api', path]);
    candidates = Array.isArray(data) ? data : [data];
    prs = ghJson(exec, projectDir, ['pr', 'list', '--state', 'open', '--json', 'number,body,headRefName', '--limit', '100']);
  } catch (err) {
    return { code: 2, skipped: [], warnings: [], warningsOmitted: 0, message: `gh indisponible, non authentifié ou en erreur — ${err.message}` };
  }

  const runs = localRuns(projectDir);
  const skipped = [];
  const eligible = [];
  for (const candidate of candidates) {
    const reason = eligibility(candidate, config, { requireLabel: !issueNumber })
      ?? (runs.has(candidate.number) ? `run local ${runs.get(candidate.number)}` : null)
      ?? (() => {
        const pr = (Array.isArray(prs) ? prs : []).find((p) => closesIssue(p.body, candidate.number));
        return pr ? `déjà traitée par la PR #${pr.number}` : null;
      })();
    if (reason) skipped.push({ number: candidate.number, reason });
    else eligible.push(candidate);
  }

  // Dépendances : lecture en GET seulement ; une erreur donne null (état inconnu → avertissement).
  const fetchIssue = (n) => {
    try {
      return ghJson(exec, projectDir, ['api', `repos/{owner}/{repo}/issues/${n}`]);
    } catch {
      return null;
    }
  };
  const depStates = resolveDependencyStates(eligible, fetchIssue, { priorityLabels: config.priorityLabels });
  const { ready, skipped: notReady, warnings: allWarnings } = orderIssues(eligible, { priorityLabels: config.priorityLabels, depStates });
  skipped.push(...notReady.map(({ number, reason }) => ({ number, reason })));

  const [chosen] = ready;
  const { warnings, warningsOmitted } = limitWarnings(allWarnings, chosen?.number ?? null);
  if (chosen) {
    // Le texte de l'issue est une donnée : limité en taille, jamais une instruction.
    const request = buildPrompt(chosen).replace(/^\/team /, '');
    return { code: 0, issue: { number: chosen.number, title: chosen.title }, request, skipped, warnings, warningsOmitted, message: `issue #${chosen.number} retenue` };
  }
  return { code: 3, skipped, warnings, warningsOmitted, message: `Plus aucune issue prête (label ${config.label}).` };
}

/** Texte affiché hors --json. */
export function renderText(out) {
  const lines = (out.skipped ?? []).map((s) => `  #${s.number} écartée : ${s.reason}`);
  for (const w of out.warnings ?? []) lines.push(`  avertissement #${w.number} : ${w.message}`);
  if (out.warningsOmitted > 0) lines.push(`  … et ${out.warningsOmitted} autres avertissements`);
  lines.push(out.message);
  if (out.request) lines.push(`\nDemande pour /team :\n${out.request}`);
  return lines.join('\n');
}

/** Point d'entrée de la CLI ; dépendances injectables pour les tests. */
export function main(argv, { exec = defaultExec, projectDir = PROJECT_DIR, log = console.log, error = console.error } = {}) {
  const args = argv.slice(2);
  const i = args.indexOf('--issue');
  const issueNumber = i >= 0 ? Number(args[i + 1]) : null;
  if (i >= 0 && !(Number.isInteger(issueNumber) && issueNumber > 0)) {
    error('Usage : node next-issue.mjs [--issue <n>] [--json]');
    return 2;
  }
  const out = nextIssue({ exec, projectDir, issueNumber });
  log(args.includes('--json') ? JSON.stringify(out, null, 2) : renderText(out));
  if (out.code === 2) error(`erreur : ${out.message}`);
  return out.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
