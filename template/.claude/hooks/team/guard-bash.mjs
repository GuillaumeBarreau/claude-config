#!/usr/bin/env node
// Hook PreToolUse (Bash, PowerShell) : garde-fou des commandes shell, pour tous les
// agents et la session principale. Double les règles Git et sécurité de team-rules,
// qui sans lui ne reposeraient que sur le modèle.
//
// - deny : jamais acceptable pour un agent (commit ou push sur la branche de base,
//   contournement des hooks Git, lecture de secrets, suppression massive) ;
// - ask  : possible avec l'accord de l'utilisateur, demandé par Claude Code (push,
//   publication, actions destructives, ajout de dépendance, et toute commande `gh` qui
//   n'est pas une lecture connue : view, list, status, diff, checks, run watch, search,
//   `gh api` en GET sans champ).
//
// Chaque segment est normalisé avant contrôle : préfixes retirés ((, {, &, env, command,
// exec, sudo), sous-commandes $( ) et `…` examinées, premier mot réduit à son nom de base
// (gh.exe, C:\…\gh.exe, /usr/bin/gh → gh).
//
// Filet de sécurité, pas bac à sable : une commande assez détournée lui échappe.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { emitDecision, failClosed, isSecretPath, readPayload, strongest, teamConfig } from './lib.mjs';

const HOOK = 'guard-bash';
const deny = (reason) => ({ decision: 'deny', reason });
const ask = (reason) => ({ decision: 'ask', reason });

const tokensOf = (text) => text.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''));

// Préfixes qui lancent la commande suivante sans la changer (Bash et PowerShell).
const PREFIX = /^(?:[({&]\s*|(?:env|command|exec|sudo)(?:\s+-\S+)*\s+|\w+=\S*\s+)/;

/** Nom de base du premier mot : sans guillemets, chemin ni extension, en minuscules. */
const baseName = (word) => word.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/**
 * Découpe sur && || ; | et retours à la ligne, mais aussi sur $( ` ( ) pour voir les
 * sous-commandes ; retire les préfixes ((, {, &, env VAR=x, command, exec, sudo).
 * Renvoie { cmd, tokens } : cmd est le nom de base du premier mot, tokens la suite.
 */
function segments(command) {
  return command.split(/&&|\|\||;|\||\r?\n|\$\(|`|\(|\)/).map((raw) => {
    let s = raw.trim();
    for (let prev; prev !== s;) { prev = s; s = s.replace(PREFIX, ''); }
    // Premier mot entre guillemets : chemin avec espaces (PowerShell : & "C:\...\gh.exe").
    const quoted = /^(["'])(.*?)\1(?:\s+|$)/.exec(s);
    const first = quoted ? quoted[2] : s.split(/\s+/)[0];
    return { cmd: baseName(first), tokens: tokensOf(s.slice(quoted ? quoted[0].length : first.length)) };
  }).filter((seg) => seg.cmd);
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

// gh : logique inversée. Seules les lectures connues passent sans question ; tout le
// reste (commentaire, revue, relance, secret, workflow, appel API modifiant...) demande
// un accord. Fusionner une PR reste humain : refusé, y compris par l'API.
const MERGE_DENY = 'la fusion d\'une PR reste humaine : un agent ne fusionne jamais, même en auto-merge';
const GH_READ_VERBS = new Set(['view', 'list', 'ls', 'status', 'diff', 'checks']);
const GH_API_FIELD = /^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF]./;

function checkGhApi(args) {
  let method = null;
  let field = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') method = args[i + 1] ?? '';
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (a.startsWith('--method=')) method = a.slice('--method='.length);
    else if (GH_API_FIELD.test(a)) field ??= a;
  }
  // Sans --method, gh passe en POST dès qu'un champ est fourni.
  const write = method !== null ? method.toUpperCase() !== 'GET' : field !== null;
  if (write && args.some((a) => /\/pulls\/[^/\s]+\/merge\b/.test(a))) return deny(MERGE_DENY);
  if (args.some((a) => /mergePullRequest|enablePullRequestAutoMerge/i.test(a))) return deny(MERGE_DENY);
  if (method !== null && method.toUpperCase() !== 'GET') return ask(`gh api --method ${method} : écriture sur GitHub, accord explicite requis`);
  if (field) return ask(`gh api ${field} : envoi de données à GitHub, accord explicite requis`);
  return null;
}

function checkGh(rest) {
  // -R/--repo peut précéder ou suivre la sous-commande : on l'ignore pour la reconnaître.
  const args = rest.filter((a, i) => !['-R', '--repo'].includes(a) && !['-R', '--repo'].includes(rest[i - 1]) && !a.startsWith('--repo='));
  const [group, verb] = args;
  if (group === 'pr' && verb === 'merge') return deny(MERGE_DENY);
  if (group === 'api') return checkGhApi(args.slice(1));
  if (!args.length || ['--version', 'version', 'help', '--help', 'status', 'search'].includes(group)) return null;
  if (group === 'auth' && verb === 'status') return null;
  if (GH_READ_VERBS.has(verb) || (group === 'run' && verb === 'watch')) return null;
  return ask(`gh ${args.slice(0, 2).join(' ')} : action GitHub hors lecture, accord explicite requis`);
}

function checkSegment({ cmd, tokens: rest }, ctx) {
  if (cmd === 'git') {
    let i = 0;
    while (i < rest.length && rest[i].startsWith('-')) i += ['-C', '-c'].includes(rest[i]) ? 2 : 1;
    return rest[i] ? checkGit(rest[i], rest.slice(i + 1), ctx) : null;
  }
  if (cmd === 'gh') return checkGh(rest);
  if (cmd === 'glab' && /^mr merge\b/.test(rest.join(' '))) return deny(MERGE_DENY);
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
  const parts = segments(command);
  // Le message d'un commit peut s'étaler sur plusieurs lignes (heredoc) : on regarde
  // la commande entière dès qu'elle contient un git commit.
  if (/co-authored-by:/i.test(command) && parts.some((s) => s.cmd === 'git' && s.tokens.includes('commit'))) {
    results.push(deny('pas de mention Co-Authored-By dans les messages de commit : retire la ligne'));
  }
  for (const segment of parts) results.push(checkSegment(segment, ctx));
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
