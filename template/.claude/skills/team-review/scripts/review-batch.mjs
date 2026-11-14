#!/usr/bin/env node
// Prépare hors session la revue des PR en attente : pour chacune, lance
// `claude -p "/team-review <n> --prepare"` (relecture et fusion des constats, sans triage ni
// publication). À lancer depuis un terminal ou un planificateur, jamais depuis une
// session Claude Code.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/review-batch.mjs [--max <n>] [--worktree]          simulation
//   node .claude/skills/team-review/scripts/review-batch.mjs --yes [--max <n>] [--worktree]    mode réel
//
// - Sans --yes : SIMULATION. Liste les PR que `pr-list --pending` renvoie (relecture
//   demandée ou PR de l'utilisateur, jamais revues ou modifiées depuis) et la commande
//   qui serait lancée. Seulement des lectures gh ; rien n'est écrit.
// - Avec --yes : lance claude pour chaque PR, en série, au plus --max (défaut
//   team.json review.batch.maxPrs, sinon 3). Coûte des appels API ; refusé si CLAUDECODE
//   est défini. Rapport : .agent-reviews/batch/<horodatage>.json.
// - --worktree : transmis tel quel à /team-review (lecture de la PR dans un worktree
//   jetable) ; sans l'option, rien n'est transmis (mode git-show ou working-tree).
// - Ne publie jamais : la publication reste publish.mjs, après triage et accord.
// Sortie : 0 ; 1 si une préparation a échoué ; 2 refus ou erreur (CLAUDECODE, gh,
// arguments).

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultExec } from '../../team-backlog/scripts/backlog.mjs';
import { CLAUDE_DIR, createExec, readTeam, writeJson } from '../../team/scripts/gh.mjs';
import { prList } from './pr-list.mjs';
import { reviewConfig, reviewsRoot } from './store.mjs';

const CLAUDE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const flat = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Arguments de claude pour une PR : le numéro vient de gh, jamais du texte d'une PR. */
export const claudeArgs = (number, { worktree = false } = {}) => ['-p', `/team-review ${number}${worktree ? ' --worktree' : ''} --prepare`, '--output-format', 'json'];

export function parseArgs(argv) {
  const args = { yes: false, max: null, worktree: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') args.yes = true;
    else if (a === '--worktree') args.worktree = true;
    else if (a === '--max') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--max attend un entier > 0');
      args.max = n;
    } else throw new Error(`argument inconnu : ${a}`);
  }
  return args;
}

/** Exécuteur réel : gh sans shell ; claude par l'exécuteur de backlog.mjs (claude.cmd sous Windows). */
function realExec(projectDir) {
  const gh = createExec(projectDir);
  return (cmd, args) => {
    if (cmd !== 'claude') return gh(cmd, args);
    const res = defaultExec(cmd, args, { cwd: projectDir, timeout: CLAUDE_TIMEOUT_MS });
    return { code: res.status ?? 127, stdout: res.stdout, stderr: res.stderr };
  };
}

/**
 * Point d'entrée testable. exec(cmd, args) → { code, stdout, stderr } est injectable.
 * @returns {{ code, report }}
 */
export function reviewBatch({ argv, claudeDir = CLAUDE_DIR, exec, env = process.env, now = () => new Date(), log = console.log, warn = console.error }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    warn(`erreur : ${err.message}`);
    return { code: 2, report: null };
  }
  if (args.yes && env.CLAUDECODE !== undefined) {
    warn('Refus : CLAUDECODE est défini (session Claude Code). Lance le mode réel depuis un terminal ou un planificateur.');
    return { code: 2, report: null };
  }
  const projectDir = dirname(claudeDir);
  exec = exec ?? realExec(projectDir);
  const max = args.max ?? reviewConfig(readTeam(claudeDir)).batch.maxPrs;
  const list = prList({ claudeDir, exec, pending: true });
  if (list.code !== 0) {
    warn(`erreur : ${list.message}`);
    return { code: 2, report: null };
  }
  const startedAt = now();
  const report = { startedAt: startedAt.toISOString(), dryRun: !args.yes, max, prs: [], skipped: [] };
  let failed = false;
  for (const [i, pr] of list.prs.entries()) {
    if (i >= max) {
      report.skipped.push({ number: pr.number, reason: `au-delà de la limite (${max})` });
      continue;
    }
    const entry = { number: pr.number, title: flat(pr.title, 200), state: pr.state, command: `claude ${claudeArgs(pr.number, args).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}` };
    if (!args.yes) entry.outcome = 'dry-run';
    else {
      const res = exec('claude', claudeArgs(pr.number, args));
      entry.exit = res.code;
      entry.outcome = res.code === 0 ? 'prepared' : 'error';
      try {
        const out = JSON.parse(res.stdout);
        entry.costUsd = out.total_cost_usd ?? null;
        entry.turns = out.num_turns ?? null;
      } catch {
        entry.costUsd = null;
      }
      if (res.code !== 0) {
        failed = true;
        entry.reason = flat(res.stderr || `code ${res.code}`, 300);
      }
    }
    report.prs.push(entry);
    log(`#${entry.number} ${entry.title} (${entry.state}) → ${entry.outcome}${args.yes ? '' : ` : ${entry.command}`}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  report.finishedAt = now().toISOString();
  let where = '';
  if (args.yes) {
    const dir = join(reviewsRoot(claudeDir), 'batch');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    writeJson(file, report);
    where = ` Rapport : ${file}`;
  }
  log(`${report.prs.length} PR ${args.yes ? 'préparée(s)' : 'à préparer (simulation : relance avec --yes pour lancer claude)'}, ${report.skipped.length} ignorée(s).${where}`);
  return { code: failed ? 1 : 0, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(reviewBatch({ argv: process.argv.slice(2) }).code);
}
