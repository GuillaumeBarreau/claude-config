#!/usr/bin/env node
// Fusionne les livrables des agents du dernier round dans review.json : dédoublonnage,
// verdicts du vérificateur, étiquettes, ancrage dans le diff, suivi entre rounds.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/findings.mjs .agent-reviews/pr-<n>
//
// - Empreinte d'un constat : sha256 de fichier + extrait normalisé + nature. Deux
//   constats de même empreinte dans le round n'en font qu'un (axes et agents réunis,
//   sévérité la plus haute). Identifiants globaux stables R1, R2…
// - Verdicts de cc-pr-verifier : rejected → constat gardé, décision « ko » et note ;
//   downgraded → sévérité remplacée, l'originale gardée dans verification.
// - Étiquette par défaut : question ou sans preuve → ASK ; critical → MUST, major →
//   SHOULD, minor → COULD. Ancrage « line » si la ligne est ajoutée ou de contexte, côté
//   droit d'un hunk de diff.patch ; sinon « body ».
// - Suivi : empreinte déjà connue → persisting (décision, note, commentaire édité et
//   publication conservés) ; constat absent du round → fixed si son fichier a changé
//   depuis le round précédent (`gh api repos/{owner}/{repo}/compare/<a>...<b>`, lecture)
//   et que l'extrait n'est plus dans le diff, sinon unknown.
// - Écrit rounds/<k>/verify-input.json : les constats critical et major à contre-vérifier,
//   réduits à id, file, line, title, problem, scenario (sans preuve ni raisonnement).
//   Rien à vérifier : le fichier n'existe pas (supprimé s'il restait d'un passage précédent).
// - Idempotent : relancé sans nouveau livrable, review.json ne change pas.
// Sortie : 0 ok, 2 erreur (aucun livrable, review.json invalide, arguments).

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PR_REVIEWERS } from '../../team/scripts/deliverable.mjs';
import { CLAUDE_DIR, GhError, addLog, createExec, readJson, runJson, writeJson } from '../../team/scripts/gh.mjs';
import { normalizePath } from '../../team/scripts/sensitive.mjs';
import {
  SEVERITY_ORDER, counters, defaultLabel, fingerprint, hunkOf, lastRound, loadReview, parseDiff, roundDir, snippetInDiff,
} from './store.mjs';

const ACTOR = 'findings';
const CONTENT = ['severity', 'kind', 'file', 'line', 'endLine', 'snippet', 'title', 'problem', 'scenario', 'fix', 'proof', 'evidence', 'regression', 'suggestion'];
const rank = (severity) => SEVERITY_ORDER.indexOf(severity);

/** Livrables du round, dans l'ordre d'arrivée : le dernier de chaque relecteur, tous ceux du vérificateur. */
function readDeliverables(dir) {
  if (!existsSync(dir)) return { reviewers: [], verdicts: [] };
  const all = readdirSync(dir).filter((f) => /^\d+-.+\.json$/.test(f)).sort().map((f) => readJson(join(dir, f)));
  const byAgent = new Map();
  for (const d of all.filter((d) => PR_REVIEWERS.includes(d?.agent))) byAgent.set(d.agent, d);
  const verdicts = new Map();
  for (const d of all.filter((d) => d?.agent === 'cc-pr-verifier')) {
    for (const v of Array.isArray(d.verdicts) ? d.verdicts : []) verdicts.set(v.finding, v);
  }
  return { reviewers: [...byAgent.values()], verdicts: [...verdicts.values()], count: all.length };
}

/** Constats du round, un par empreinte : axes et agents réunis, contenu du plus sévère. */
function mergeRound(reviewers) {
  const merged = new Map();
  for (const d of reviewers) {
    for (const raw of Array.isArray(d.findings) ? d.findings : []) {
      const f = { ...raw, file: normalizePath(raw.file), endLine: raw.endLine ?? null, suggestion: raw.suggestion ?? null };
      const print = fingerprint(f);
      const seen = merged.get(print);
      if (!seen) merged.set(print, { finding: f, axes: [d.axis], agents: [d.agent] });
      else {
        if (!seen.axes.includes(d.axis)) seen.axes.push(d.axis);
        if (!seen.agents.includes(d.agent)) seen.agents.push(d.agent);
        if (rank(f.severity) < rank(seen.finding.severity)) seen.finding = f;
      }
    }
  }
  return merged;
}

/** Ancrage dans le diff : line si la ligne est côté droit d'un hunk ; endLine et suggestion gardés seulement dans le même hunk. */
export function anchorOf(diff, f) {
  const hunk = hunkOf(diff, f.file, f.line);
  if (!hunk) return { anchor: 'body', endLine: f.endLine, suggestion: f.suggestion };
  if (f.endLine !== null && f.endLine !== f.line && !hunk.lines.has(f.endLine)) return { anchor: 'line', endLine: null, suggestion: null };
  return { anchor: 'line', endLine: f.endLine, suggestion: f.suggestion };
}

function applyVerdicts(review, verdicts, warnings) {
  for (const v of verdicts) {
    const f = review.findings.find((x) => x.id === v.finding);
    if (!f) {
      warnings.push(`verdict pour « ${v.finding} » : constat inconnu, ignoré`);
      continue;
    }
    const original = f.verification?.originalSeverity ?? f.severity;
    let verdict = v.verdict;
    if (verdict === 'downgraded' && !(rank(v.severity) > rank(original))) {
      warnings.push(`verdict pour ${f.id} : « ${v.severity} » n'est pas plus bas que « ${original} », sévérité conservée (confirmed)`);
      verdict = 'confirmed';
    }
    if (f.verification && f.verification.verdict === verdict && f.verification.reason === v.reason) continue;
    f.verification = { verdict, reason: v.reason, originalSeverity: original };
    if (verdict === 'downgraded') {
      const before = defaultLabel({ ...f, severity: original });
      f.severity = v.severity;
      // L'étiquette suit la sévérité tant que l'utilisateur ne l'a pas choisie lui-même.
      if (f.label === before && !f.publication) f.label = defaultLabel(f);
    }
    if (verdict === 'rejected' && !f.publication) {
      f.decision = 'ko';
      f.note = `écarté par le vérificateur : ${v.reason}`;
    }
  }
}

/** Fichiers modifiés entre deux commits (lecture gh) ; comparaison impossible → null. */
function changedBetween(exec, a, b, warnings) {
  try {
    const cmp = runJson(exec, 'gh', ['api', `repos/{owner}/{repo}/compare/${a}...${b}`]);
    return new Set((cmp.files ?? []).map((f) => normalizePath(f.filename)));
  } catch (err) {
    if (!(err instanceof GhError)) throw err;
    warnings.push(`comparaison ${a.slice(0, 7)}...${b.slice(0, 7)} impossible (${err.message}) : constats absents marqués « unknown »`);
    return null;
  }
}

/**
 * Renvoie { code, message, review, warnings, changed }. exec et now sont injectables.
 * N'écrit review.json que s'il change.
 */
export function mergeFindings({ reviewDir, claudeDir = CLAUDE_DIR, exec, now = () => new Date() }) {
  const loaded = loadReview(reviewDir);
  if (loaded.error) return { code: 2, message: loaded.error };
  const review = loaded.review;
  const before = JSON.stringify(review);
  const round = lastRound(review);
  const dir = roundDir(reviewDir, round.n);
  let deliverables;
  try {
    deliverables = readDeliverables(join(dir, 'deliverables'));
  } catch (err) {
    return { code: 2, message: `livrable illisible dans ${join(dir, 'deliverables')} : ${err.message}` };
  }
  if (!deliverables.reviewers.length) {
    return { code: 2, message: `aucun livrable de relecteur dans ${join(dir, 'deliverables')} (round ${round.n})` };
  }
  const diffPath = join(dir, 'diff.patch');
  const diff = parseDiff(existsSync(diffPath) ? readFileSync(diffPath, 'utf8') : '');
  const warnings = [];
  const known = new Map(review.findings.map((f) => [f.fingerprint, f]));
  let next = Math.max(0, ...review.findings.map((f) => Number(/^R(\d+)$/.exec(f.id)?.[1] ?? 0))) + 1;

  for (const [print, { finding, axes, agents }] of mergeRound(deliverables.reviewers)) {
    const existing = known.get(print);
    const position = anchorOf(diff, finding);
    if (existing) {
      for (const a of axes) if (!existing.axes.includes(a)) existing.axes.push(a);
      for (const a of agents) if (!existing.agents.includes(a)) existing.agents.push(a);
      if (existing.lastRound === round.n) continue;
      // Déjà connu d'un round précédent : seul l'emplacement suit le nouveau diff.
      Object.assign(existing, { lastRound: round.n, tracking: 'persisting', line: finding.line, ...position });
      continue;
    }
    const content = Object.fromEntries(CONTENT.map((key) => [key, finding[key]]));
    content.preexisting = finding.preexisting === true;
    review.findings.push({
      id: `R${next++}`, fingerprint: print, axes, agents, firstRound: round.n, lastRound: round.n, tracking: 'new',
      ...content, ...position, verification: null, label: defaultLabel(finding), comment: finding.comment, draft: finding.comment,
      decision: null, rating: null, note: '', publication: null,
    });
  }

  const gone = review.findings.filter((f) => f.lastRound < round.n && ['new', 'persisting'].includes(f.tracking));
  if (gone.length) {
    exec = exec ?? createExec(dirname(claudeDir));
    const changed = round.previousHeadSha ? changedBetween(exec, round.previousHeadSha, round.headSha, warnings) : null;
    for (const f of gone) {
      f.tracking = changed?.has(normalizePath(f.file)) && !snippetInDiff(diff, f.file, f.snippet) ? 'fixed' : 'unknown';
    }
  }

  applyVerdicts(review, deliverables.verdicts, warnings);
  if (round.status === 'fetched') round.status = 'reviewed';

  const active = review.findings.filter((f) => f.lastRound === round.n);
  const toVerify = active.filter((f) => ['critical', 'major'].includes(f.verification?.originalSeverity ?? f.severity) && !f.verification)
    .map(({ id, file, line, title, problem, scenario }) => ({ id, file, line, title, problem, scenario }));
  const verifyPath = join(dir, 'verify-input.json');
  const verifyInput = { review: review.id, round: round.n, findings: toVerify };
  if (!toVerify.length) {
    if (existsSync(verifyPath)) rmSync(verifyPath);
  } else if (!existsSync(verifyPath) || JSON.stringify(readJson(verifyPath)) !== JSON.stringify(verifyInput)) {
    writeJson(verifyPath, verifyInput);
  }

  const changed = JSON.stringify(review) !== before;
  if (changed) {
    const at = now().toISOString();
    addLog(review, at, ACTOR, 'findings_merged', `round ${round.n} : ${active.length} constat(s), ${deliverables.verdicts.length} verdict(s)`);
    writeJson(join(reviewDir, 'review.json'), review);
  }
  const c = counters(active);
  const labels = Object.entries(c.labels).filter(([, n]) => n).map(([l, n]) => `${n} ${l}`).join(', ') || 'aucun constat';
  const message = `${review.id} round ${round.n} : ${labels} ; ${c.rejectedByVerifier} écarté(s) par le vérificateur ; ${toVerify.length} à contre-vérifier`
    + `${changed ? '' : ' (rien de nouveau)'}`
    + (round.source?.mode === 'git-show' ? ' ; lecture git-show : fichiers hors PR lus sur la branche courante, à rappeler dans les limites' : '');
  return { code: 0, message, review, warnings, changed };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('--')) {
    console.error('Usage : node findings.mjs .agent-reviews/pr-<n>');
    return 2;
  }
  let out;
  try {
    out = mergeFindings({ reviewDir: resolve(args[0]) });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 2;
  }
  (out.code === 2 ? console.error : console.log)(out.code === 2 ? `erreur : ${out.message}` : out.message);
  for (const w of out.warnings ?? []) console.error(`avertissement : ${w}`);
  return out.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
