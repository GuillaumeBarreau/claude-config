#!/usr/bin/env node
// Liste les PR ouvertes du dépôt et leur état de revue local (.agent-reviews/).
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/pr-list.mjs [--pending] [--json]
//
// - Lit `gh pr list --json number,title,author,headRefOid,isDraft,reviewRequests,
//   updatedAt,url` et `gh api user` (login). Lecture seule : rien n'est écrit, ni sur
//   GitHub ni sur le disque.
// - État par PR : « jamais revue », « à trier », « publiée », ou « modifiée depuis »
//   (le commit de tête n'est plus celui du dernier round).
// - --pending : seulement les PR où ta relecture est demandée ou dont tu es l'auteur, et
//   qui sont « jamais revue » ou « modifiée depuis ».
// Sortie : 0 ; 2 erreur (gh absent ou non authentifié, arguments).

import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLAUDE_DIR, GhError, createExec, runJson } from '../../team/scripts/gh.mjs';
import { lastRound, listReviewDirs, loadReview } from './store.mjs';

export const STATES = { never: 'jamais revue', triage: 'à trier', published: 'publiée', changed: 'modifiée depuis' };
export const LIST_FIELDS = 'number,title,author,headRefOid,isDraft,reviewRequests,updatedAt,url';

/** État local d'une PR d'après son dossier de revue (absent ou illisible : jamais revue). */
function stateOf(review, headSha) {
  if (!review) return STATES.never;
  const round = lastRound(review);
  if (round.headSha !== headSha) return STATES.changed;
  return round.status === 'published' ? STATES.published : STATES.triage;
}

/**
 * @returns {{ code: 0|2, message?: string, login?: string, prs?: object[] }}
 * prs : { number, title, author, url, isDraft, updatedAt, headSha, requested, mine, state }.
 */
export function prList({ claudeDir = CLAUDE_DIR, exec, pending = false } = {}) {
  exec = exec ?? createExec(dirname(claudeDir));
  try {
    const list = runJson(exec, 'gh', ['pr', 'list', '--json', LIST_FIELDS]);
    const login = runJson(exec, 'gh', ['api', 'user']).login ?? '';
    const reviews = new Map(listReviewDirs(claudeDir).map(({ dir, name }) => [name, loadReview(dir).review]));
    let prs = (Array.isArray(list) ? list : []).map((pr) => {
      const author = pr.author?.login ?? '';
      return {
        number: pr.number,
        title: pr.title ?? '',
        author,
        url: pr.url ?? '',
        isDraft: pr.isDraft === true,
        updatedAt: pr.updatedAt ?? null,
        headSha: pr.headRefOid ?? null,
        // Une demande adressée à une équipe ne porte pas de login : elle n'est pas comptée.
        requested: (pr.reviewRequests ?? []).some((r) => r?.login && r.login === login),
        mine: Boolean(login) && author === login,
        state: stateOf(reviews.get(`pr-${pr.number}`) ?? null, pr.headRefOid ?? null),
      };
    });
    if (pending) prs = prs.filter((p) => (p.requested || p.mine) && [STATES.never, STATES.changed].includes(p.state));
    return { code: 0, login, prs };
  } catch (err) {
    if (err instanceof GhError) return { code: 2, message: err.message };
    throw err;
  }
}

/** Tableau lisible ; les titres viennent de tiers : une ligne, tronquée. */
export function formatList(prs) {
  if (!prs.length) return 'Aucune PR.';
  const flat = (s, max) => {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  return prs.map((p) => {
    const role = p.mine ? 'auteur' : p.requested ? 'relecture demandée' : '';
    return `#${p.number}  ${p.state.padEnd(15)}  @${flat(p.author, 24).padEnd(24)}  ${flat(p.title, 70)}${p.isDraft ? ' [brouillon]' : ''}${role ? ` (${role})` : ''}`;
  }).join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const unknown = args.find((a) => !['--pending', '--json'].includes(a));
  if (unknown) {
    console.error(`Usage : node pr-list.mjs [--pending] [--json] (argument inconnu : ${unknown})`);
    return 2;
  }
  const out = prList({ pending: args.includes('--pending') });
  if (out.code !== 0) {
    console.error(`erreur : ${out.message}`);
    return out.code;
  }
  console.log(args.includes('--json') ? JSON.stringify({ login: out.login, prs: out.prs }, null, 2) : formatList(out.prs));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
