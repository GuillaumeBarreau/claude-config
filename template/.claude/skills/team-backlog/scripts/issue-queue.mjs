// Fonctions pures de sélection des issues, partagées par next-issue.mjs et backlog.mjs :
// issue prête (rubriques minimales), dépendances « Dépend de #n », priorité, ordre.
// Aucune entrée-sortie et aucun import : le texte d'une issue est une donnée, analysée
// seulement par expressions régulières (jamais exécutée, jamais publiée en entier).

export const MAX_BODY = 4000;
export const DEFAULT_PRIORITY_LABELS = ['P0', 'P1', 'P2'];

// Libellés exacts du modèle d'issue (/team-init) ; `aliases` : titres acceptés, une fois
// normalisés (sans accents, en minuscules), comme début du titre de la rubrique.
export const READY_SECTIONS = [
  { label: 'Objectif', aliases: ['objectif'] },
  { label: 'Comportement attendu ou critères', aliases: ['comportement attendu', 'criteres'] },
  { label: 'Hors périmètre', aliases: ['hors perimetre'] },
];

const MAX_EXCERPT = 80;
const normalizeText = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const stripComments = (text) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
const flat = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Texte de l'issue transmis à l'agent : normalisé et limité à MAX_BODY caractères. */
export function retainedBody(body) {
  return String(body ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY);
}

/** Libellés des rubriques minimales absentes ou vides du texte retenu, dans l'ordre de READY_SECTIONS. */
export function missingSections(body) {
  const lines = stripComments(retainedBody(body)).split('\n');
  const headings = [];
  lines.forEach((line, index) => {
    // Sans quantificateur ambigu (temps linéaire) ; la classe « tout sauf saut de ligne »
    // admet U+000D, U+2028 et U+2029 laissés par split. La séquence de fermeture
    // (« ## Titre ## ») est retirée ensuite, en code.
    const m = /^ {0,3}(#{1,6})(?:[ \t]([^\n]*))?$/.exec(line);
    if (!m) return;
    const text = (m[2] ?? '').trim().replace(/(?:^|[ \t])#+$/, '');
    const title = normalizeText(text).replace(/\s+/g, ' ').trim().replace(/:$/, '').trim();
    headings.push({ index, level: m[1].length, title });
  });
  const hasContent = (heading) => {
    const next = headings.find((h) => h.index > heading.index && h.level <= heading.level);
    return lines.slice(heading.index + 1, next ? next.index : lines.length).some((l) => l.trim() !== '');
  };
  return READY_SECTIONS.filter(({ aliases }) => !headings.some(
    (h) => aliases.some((alias) => h.title.startsWith(alias)) && hasContent(h),
  )).map((s) => s.label);
}

/**
 * Références « Dépend de #n » : sur chaque ligne qui contient « dépend de », les #n
 * précédés d'un début de ligne, d'une espace ou de ( , ; : . Une ligne sans référence
 * lisible, ou une référence d'une autre forme (o/r#3), va en `unreadable` (extrait ≤ 80).
 * @returns {{ numbers: number[], unreadable: string[] }}
 */
export function dependencyRefs(body) {
  const numbers = new Set();
  const unreadable = [];
  const text = stripComments(String(body ?? '').replace(/\r\n/g, '\n'));
  for (const line of text.split('\n')) {
    if (!/depend de/.test(normalizeText(line))) continue;
    let readable = 0;
    let bad = false;
    for (const m of line.matchAll(/#(\d+)/g)) {
      const before = m.index === 0 ? ' ' : line[m.index - 1];
      const after = line[m.index + m[0].length];
      const n = Number(m[1]);
      if (/[\s(,;:]/.test(before) && !(after && /\w/.test(after)) && Number.isSafeInteger(n)) {
        numbers.add(n);
        readable += 1;
      } else bad = true;
    }
    if (!readable || bad) unreadable.push(flat(line, MAX_EXCERPT));
  }
  return { numbers: [...numbers].sort((a, b) => a - b), unreadable };
}

const labelNames = (issue) => (Array.isArray(issue?.labels) ? issue.labels : [])
  .map((l) => (typeof l === 'string' ? l : l?.name))
  .filter((n) => typeof n === 'string')
  .map((n) => n.trim().toLowerCase());

/** Rang de priorité : plus petit indice des labels présents dans priorityLabels, sinon leur nombre (en dernier). */
export function priorityRank(issue, priorityLabels) {
  const wanted = priorityLabels.map((l) => String(l).trim().toLowerCase());
  const ranks = labelNames(issue).map((n) => wanted.indexOf(n)).filter((i) => i >= 0);
  return ranks.length ? Math.min(...ranks) : priorityLabels.length;
}

const stateOf = (value) => String(value?.state ?? '').toLowerCase();

// Ordre de traitement : priorité, puis date de création (absente → en dernier), puis numéro.
const sortIssues = (issues, priorityLabels) => {
  const time = (issue) => (issue.created_at ? String(issue.created_at) : '￿');
  return [...issues].sort((a, b) => priorityRank(a, priorityLabels) - priorityRank(b, priorityLabels)
    || (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : 0)
    || a.number - b.number);
};

/**
 * États des issues citées en dépendance : ceux des issues reçues (ouvertes) sans appel,
 * `fetchIssue(n)` pour les autres, au plus `max` appels, en servant d'abord les issues
 * les plus prioritaires (même ordre qu'orderIssues). Échec (null, exception) → absent.
 * @returns {Map<number, { state: string, body: string }>}
 */
export function resolveDependencyStates(issues, fetchIssue, { max = 20, priorityLabels = DEFAULT_PRIORITY_LABELS } = {}) {
  const states = new Map();
  for (const issue of issues) states.set(issue.number, { state: 'open', body: String(issue.body ?? '') });
  const wanted = [];
  for (const issue of sortIssues(issues, priorityLabels)) {
    for (const n of dependencyRefs(issue.body).numbers) {
      if (!states.has(n) && !wanted.includes(n)) wanted.push(n);
    }
  }
  for (const n of wanted.slice(0, Math.max(0, max))) {
    let found = null;
    try {
      found = fetchIssue(n);
    } catch {
      found = null;
    }
    if (found && typeof found === 'object') states.set(n, { state: stateOf(found), body: String(found.body ?? '') });
  }
  return states;
}

/**
 * Trie les issues candidates (priorité, puis date de création, puis numéro) et sépare les
 * prêtes des écartées (rubriques manquantes, dépendance ouverte, cycle). Une dépendance
 * inconnue ou illisible n'écarte pas l'issue : elle produit un avertissement.
 * @returns {{ ready: object[], skipped: { number, reason, kind, missing? }[], warnings: { number, message }[] }}
 */
export function orderIssues(issues, { priorityLabels = DEFAULT_PRIORITY_LABELS, depStates = new Map() } = {}) {
  const sorted = sortIssues(issues, priorityLabels);

  const known = new Map();
  for (const issue of issues) known.set(issue.number, { state: 'open', body: issue.body });
  for (const [n, value] of depStates) known.set(n, value);
  const openDeps = (n) => dependencyRefs(known.get(n)?.body).numbers.filter((d) => stateOf(known.get(d)) === 'open');

  // Chemin de dépendances ouvertes qui revient à `start`, ou null.
  const cycleFrom = (start) => {
    const seen = new Set();
    const walk = (n, path) => {
      for (const d of openDeps(n)) {
        if (d === start) return [...path, d];
        if (seen.has(d)) continue;
        seen.add(d);
        const found = walk(d, [...path, d]);
        if (found) return found;
      }
      return null;
    };
    return walk(start, [start]);
  };

  const ready = [];
  const skipped = [];
  const warnings = [];
  for (const issue of sorted) {
    const missing = missingSections(issue.body);
    if (missing.length) {
      skipped.push({ number: issue.number, kind: 'not_ready', reason: `issue non prête : ${missing.join(', ')}`, missing });
      continue;
    }
    const { numbers, unreadable } = dependencyRefs(issue.body);
    for (const excerpt of unreadable) {
      warnings.push({ number: issue.number, message: `référence de dépendance illisible : « ${excerpt} »` });
    }
    const open = [];
    for (const n of numbers) {
      const state = stateOf(known.get(n));
      if (state === 'open') open.push(n);
      else if (state !== 'closed') {
        warnings.push({ number: issue.number, message: `état de la dépendance #${n} inconnu : issue considérée prête` });
      }
    }
    const cycle = open.length ? cycleFrom(issue.number) : null;
    if (cycle) {
      skipped.push({ number: issue.number, kind: 'cycle', reason: `dépendances en cycle : ${cycle.map((n) => `#${n}`).join(' → ')}` });
    } else if (open.length) {
      skipped.push({ number: issue.number, kind: 'dependency', reason: `dépend de ${open.map((n) => `#${n} (ouverte)`).join(', ')}` });
    } else {
      ready.push(issue);
    }
  }
  return { ready, skipped, warnings };
}
