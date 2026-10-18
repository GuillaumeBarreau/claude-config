#!/usr/bin/env node
// Hook PreToolUse (Bash, PowerShell) : garde-fou des commandes shell, pour tous les
// agents et la session principale. Double les règles Git et sécurité de team-rules,
// qui sans lui ne reposeraient que sur le modèle.
//
// - deny : jamais acceptable pour un agent (commit ou push sur la branche de base,
//   contournement des hooks Git, lecture de secrets, suppression massive) ;
// - ask  : possible avec l'accord de l'utilisateur, demandé par Claude Code (push, PR,
//   publication, actions destructives, ajout de dépendance).
//
// Filet de sécurité, pas bac à sable : une commande assez détournée lui échappe.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { emitDecision, failClosed, isSecretPath, readPayload, strongest, teamConfig } from './lib.mjs';

const HOOK = 'guard-bash';
const deny = (reason) => ({ decision: 'deny', reason });
const ask = (reason) => ({ decision: 'ask', reason });

const tokensOf = (text) => text.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''));

/** Découpe sur && || ; | et retours à la ligne, retire VAR=x et sudo en tête. */
function segments(command) {
  return command.split(/&&|\|\||;|\||\r?\n/).map((s) => s.trim()
    .replace(/^(?:\w+=\S*\s+)+/, '').replace(/^sudo\s+/, '')).filter(Boolean);
}

function checkGit(sub, args, ctx) {
  const flags = args.filter((a) => a.startsWith('-'));
  const operands = args.filter((a) => !a.startsWith('-'));
  const base = ctx.baseBranch;
  if (['commit', 'push', 'merge'].includes(sub) && (args.includes('--no-verify') || (sub === 'commit' && flags.includes('-n')))) {
    return deny('--no-verify contourne les hooks Git du projet : interdit');
  }
  switch (sub) {
    case 'commit':
      if (ctx.currentBranch() === base) return deny(`commit interdit sur la branche de base « ${base} » : crée une branche de travail`);
      if (args.includes('--amend')) return ask('git commit --amend réécrit l\'historique');
      return null;
    case 'push': {
      const refs = operands.slice(1);
      const targetsBase = refs.some((r) => {
        const dest = r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
        return dest === base;
      });
      if (targetsBase || (!refs.length && ctx.currentBranch() === base)) {
        return deny(`push vers la branche de base « ${base} » interdit : passe par une PR`);
      }
      const force = flags.some((f) => /^(--force|--force-with-lease|-f)$/.test(f) || /^--force/.test(f)) || refs.some((r) => r.startsWith('+'));
      return ask(force ? 'push forcé : accord explicite requis' : 'push : accord explicite requis (porte 4)');
    }
    case 'reset': return args.includes('--hard') ? ask('git reset --hard perd les changements non commités') : null;
    case 'clean': return flags.some((f) => /^-[a-zA-Z]*f/.test(f) || f === '--force') ? ask('git clean supprime des fichiers non suivis') : null;
    case 'branch': return flags.some((f) => f === '-D' || (/^(-d|--delete)$/.test(f) && flags.some((g) => /^(-f|--force)$/.test(g))))
      ? ask('suppression forcée de branche') : null;
    case 'checkout': return args.includes('--') || (operands.length === 1 && operands[0] === '.')
      ? ask('git checkout -- écrase des changements locaux') : null;
    case 'restore': return !args.includes('--staged') || args.includes('--worktree') ? ask('git restore écrase des changements locaux') : null;
    case 'rebase': return args.includes('--abort') ? null : ask('git rebase réécrit l\'historique');
    case 'filter-branch': case 'filter-repo': return ask('réécriture d\'historique');
    case 'tag': return operands.length && !flags.some((f) => /^(-l|--list)$/.test(f)) ? ask('création ou suppression de tag') : null;
    case 'stash': return ['drop', 'clear'].includes(operands[0]) ? ask('git stash drop/clear perd des changements') : null;
    default: return null;
  }
}

function checkSegment(segment, ctx) {
  const tokens = tokensOf(segment);
  const [cmd] = tokens;
  if (cmd === 'git') {
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) i += ['-C', '-c'].includes(tokens[i]) ? 2 : 1;
    return tokens[i] ? checkGit(tokens[i], tokens.slice(i + 1), ctx) : null;
  }
  const rest = tokens.slice(1);
  if ((cmd === 'gh' && /^pr merge\b/.test(rest.join(' '))) || (cmd === 'glab' && /^mr merge\b/.test(rest.join(' ')))) {
    return deny('la fusion d\'une PR reste humaine : un agent ne fusionne jamais, même en auto-merge');
  }
  if (cmd === 'gh' && /^(pr (create|close|ready)|release (create|delete|upload)|repo delete)/.test(rest.join(' '))) {
    return ask(`gh ${rest.slice(0, 2).join(' ')} : accord explicite requis`);
  }
  if (cmd === 'glab' && /^mr create/.test(rest.join(' '))) return ask('glab mr create : accord explicite requis');
  if (['npm', 'pnpm', 'yarn', 'cargo', 'poetry'].includes(cmd) && rest[0] === 'publish') return ask(`${cmd} publish : accord explicite requis`);
  if (cmd === 'twine' && rest[0] === 'upload') return ask('twine upload : accord explicite requis');
  const addsPackage = (['npm', 'pnpm'].includes(cmd) && ['install', 'i', 'add'].includes(rest[0]) && rest.slice(1).some((a) => !a.startsWith('-')))
    || (['yarn', 'pnpm', 'poetry', 'uv', 'cargo'].includes(cmd) && rest[0] === 'add')
    || (['pip', 'pip3'].includes(cmd) && rest[0] === 'install')
    || (cmd === 'go' && rest[0] === 'get');
  if (addsPackage) return ask(`ajout de dépendance (${cmd} ${rest[0]}) : seulement si le plan validé le prévoit`);
  if (cmd === 'rm' && rest.some((a) => /^-[a-zA-Z]*[rR]/.test(a))
      && rest.some((a) => ['/', '/*', '~', '~/', '$HOME', '*', '.', './', '..', '../'].includes(a))) {
    return deny('suppression récursive de la racine, du dossier personnel ou du projet entier');
  }
  return null;
}

/**
 * @param ctx { baseBranch, currentBranch: () => string|null }
 * @returns {{decision: 'deny'|'ask', reason: string} | null}
 */
export function evaluateCommand(command, ctx) {
  if (typeof command !== 'string') throw new Error('tool_input.command absent');
  const results = [];
  if (tokensOf(command.replace(/[<>|;&()]/g, ' ')).some((t) => isSecretPath(t))) {
    results.push(deny('lecture d\'un fichier de secrets (.env, clé privée) interdite'));
  }
  for (const segment of segments(command)) results.push(checkSegment(segment, ctx));
  return strongest(results);
}

function main() {
  let payload;
  try {
    payload = readPayload();
    const cwd = payload.cwd || process.cwd();
    let branch;
    const currentBranch = () => {
      if (branch === undefined) {
        try {
          branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
          branch = null;
        }
      }
      return branch;
    };
    const ctx = { baseBranch: teamConfig().baseBranch || 'main', currentBranch };
    emitDecision(evaluateCommand(payload.tool_input?.command, ctx), HOOK);
  } catch (err) {
    failClosed(HOOK, err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
