#!/usr/bin/env node
// Où les agents lisent le code de la PR : la « source » d'un round, choisie par pr-fetch
// et enregistrée dans review.json (rounds[].source) et rounds/<k>/pr.json. Trois modes,
// aucun ne change la branche de l'utilisateur (jamais de checkout, switch, reset, stash) :
//
//   working-tree  HEAD de la copie de travail = commit de tête de la PR : lecture normale.
//                 Des modifications non commitées (`git status --porcelain`) sont signalées.
//   git-show      défaut sinon. `git fetch --no-tags --quiet origin
//                 +refs/pull/<n>/head:refs/claude-config/pr-<n>` (marche aussi pour un fork,
//                 ne crée pas de branche), puis `git cat-file -e <sha>^{commit}`. Les agents
//                 lisent les fichiers de la PR avec `git show <sha>:<chemin>` et
//                 `git grep -n <motif> <sha> -- <chemins>` ; rien n'est écrit dans la copie
//                 de travail.
//   worktree      avec --worktree : `git worktree add --detach .agent-reviews/pr-<n>/worktree
//                 <sha>` ; les agents ne lisent que ce dossier. Un ancien worktree de la PR
//                 est retiré avant ; un round à jour le recrée s'il manque et le garde s'il
//                 est déjà sur le commit. Pas de npm install dedans.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/source.mjs .agent-reviews/pr-<n> --remove-worktree
//
// Retire le worktree de la revue (`git worktree remove --force`, puis `git worktree prune`),
// à la clôture de la revue. Ne vise jamais autre chose qu'un dossier sous .agent-reviews/.
// Sortie : 0 (retiré, ou aucun worktree), 2 erreur (dossier hors .agent-reviews/, arguments).

import { existsSync, rmSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLAUDE_DIR, GhError, addLog, createExec, run, writeJson } from '../../team/scripts/gh.mjs';
import { loadReview, pullRef, reviewsRoot, worktreeDirOf } from './store.mjs';

const ACTOR = 'source';
const tail = (res) => String(res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ') || 'aucun message';

/** Dossier du worktree de la revue, après contrôle qu'il est bien sous .agent-reviews/<pr-n>/. */
function guardedWorktreeDir(reviewDir, claudeDir) {
  const root = resolve(reviewsRoot(claudeDir));
  const dir = resolve(reviewDir);
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || rel.includes(sep) || resolve(root, rel) !== dir) {
    throw new Error(`${reviewDir} n'est pas un dossier de revue sous ${root} (.agent-reviews/pr-<n>) : worktree non touché`);
  }
  return worktreeDirOf(dir);
}

/**
 * Retire le worktree de la revue s'il existe : `git worktree remove --force`, `git worktree
 * prune`, puis suppression du dossier s'il reste (git ne le reconnaissait plus).
 * @returns {{ dir: string, removed: boolean }}
 */
export function removeWorktree({ reviewDir, claudeDir = CLAUDE_DIR, exec }) {
  const dir = guardedWorktreeDir(reviewDir, claudeDir);
  if (!existsSync(dir)) return { dir, removed: false };
  exec = exec ?? createExec(dirname(claudeDir));
  exec('git', ['worktree', 'remove', '--force', dir]);
  exec('git', ['worktree', 'prune']);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  return { dir, removed: true };
}

function ensureWorktree({ reviewDir, claudeDir, exec, headSha }) {
  const dir = guardedWorktreeDir(reviewDir, claudeDir);
  if (existsSync(dir)) {
    const at = exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
    if (at.code === 0 && at.stdout.trim() === headSha) return { dir, kept: true };
    removeWorktree({ reviewDir, claudeDir, exec });
  } else exec('git', ['worktree', 'prune']);
  const res = exec('git', ['worktree', 'add', '--detach', dir, headSha]);
  if (res.code !== 0) throw new GhError(`git worktree add --detach ${dir} ${headSha.slice(0, 7)} a échoué (code ${res.code}) : ${tail(res)}`);
  return { dir, kept: false };
}

/**
 * Choisit et prépare la source du round. Lève GhError (sortie 2) si le dépôt Git ou le
 * commit de tête n'est pas disponible. Rien n'est écrit dans la copie de travail.
 * @returns {{ source: { mode, headSha, path }, reason: string, warnings: string[] }}
 */
export function resolveSource({ number, headSha, claudeDir = CLAUDE_DIR, reviewDir, exec, worktree = false }) {
  exec = exec ?? createExec(dirname(claudeDir));
  const projectDir = dirname(claudeDir);
  const head = exec('git', ['rev-parse', 'HEAD']);
  if (head.code !== 0) throw new GhError(`git rev-parse HEAD a échoué (code ${head.code}) : ${tail(head)} — la revue lit le code de la PR dans le dépôt Git du projet`);
  const onHead = head.stdout.trim() === headSha;
  const warnings = [];

  if (onHead && !worktree) {
    const status = run(exec, 'git', ['status', '--porcelain']);
    const dirty = status.split(/\r?\n/).filter((l) => l.trim()).length;
    if (dirty) warnings.push(`copie de travail : ${dirty} fichier(s) avec des modifications non commitées (git status --porcelain) ; les relecteurs liront ces modifications`);
    removeWorktree({ reviewDir, claudeDir, exec });
    return { source: { mode: 'working-tree', headSha, path: projectDir }, reason: 'la copie de travail est sur la tête de la PR', warnings };
  }

  if (!onHead) {
    const fetch = exec('git', ['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${number}/head:${pullRef(number)}`]);
    if (fetch.code !== 0) throw new GhError(`git fetch origin pull/${number}/head a échoué (code ${fetch.code}) : ${tail(fetch)} — le commit de tête de la PR n'est pas disponible localement`);
  }
  const present = exec('git', ['cat-file', '-e', `${headSha}^{commit}`]);
  if (present.code !== 0) throw new GhError(`commit ${headSha.slice(0, 7)} introuvable après git fetch (${tail(present)}) : la PR a peut-être bougé, relance pr-fetch`);

  if (worktree) {
    const { dir, kept } = ensureWorktree({ reviewDir, claudeDir, exec, headSha });
    return { source: { mode: 'worktree', headSha, path: dir }, reason: `demandé par --worktree${kept ? ' (worktree déjà sur ce commit, conservé)' : ''}`, warnings };
  }
  removeWorktree({ reviewDir, claudeDir, exec });
  return {
    source: { mode: 'git-show', headSha, path: null },
    reason: `la copie de travail (${head.stdout.trim().slice(0, 7)}) n'est pas sur la tête de la PR ; les fichiers de la PR se lisent avec git show ${headSha.slice(0, 7)}:<chemin>`,
    warnings,
  };
}

/** Résumé d'une source pour les messages à l'utilisateur. */
export function describeSource(source) {
  if (!source) return 'inconnue';
  return source.mode === 'git-show' ? `git-show (${source.headSha.slice(0, 7)})` : `${source.mode} (${source.path})`;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 2 || args[1] !== '--remove-worktree' || args[0].startsWith('--')) {
    console.error('Usage : node source.mjs .agent-reviews/pr-<n> --remove-worktree');
    return 2;
  }
  const reviewDir = resolve(args[0]);
  let out;
  try {
    out = removeWorktree({ reviewDir });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 2;
  }
  if (out.removed) {
    const loaded = loadReview(reviewDir);
    if (loaded.review) {
      addLog(loaded.review, new Date().toISOString(), ACTOR, 'worktree_removed', out.dir);
      writeJson(resolve(reviewDir, 'review.json'), loaded.review);
    }
    console.log(`worktree retiré : ${out.dir}`);
  } else console.log(`aucun worktree pour ${reviewDir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
