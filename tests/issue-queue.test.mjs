import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PRIORITY_LABELS, MAX_BODY, READY_SECTIONS, dependencyRefs, missingSections, orderIssues,
  priorityRank, resolveDependencyStates, retainedBody,
} from '../template/.claude/skills/team-backlog/scripts/issue-queue.mjs';
import { backlogConfig, buildPrompt } from '../template/.claude/skills/team-backlog/scripts/backlog.mjs';

const READY_BODY = '## Objectif\nCorriger le slug.\n\n## Comportement attendu ou critères\n- le slug est stable\n\n## Hors périmètre\nLe reste.\n';
const LABELS = READY_SECTIONS.map((s) => s.label);

// --- Constantes et corps retenu ---------------------------------------------

test('constantes : libellés des rubriques et priorités par défaut', () => {
  assert.equal(MAX_BODY, 4000);
  assert.deepEqual(DEFAULT_PRIORITY_LABELS, ['P0', 'P1', 'P2']);
  assert.deepEqual(LABELS, ['Objectif', 'Comportement attendu ou critères', 'Hors périmètre']);
});

test('retainedBody : null → vide, CRLF normalisés, espaces retirées, plafond MAX_BODY', () => {
  assert.equal(retainedBody(null), '');
  assert.equal(retainedBody(undefined), '');
  assert.equal(retainedBody('  a\r\nb \r\n'), 'a\nb');
  assert.equal(retainedBody('a'.repeat(MAX_BODY + 10)).length, MAX_BODY);
});

test('buildPrompt : sortie inchangée avec retainedBody (troncature et suffixe compris)', () => {
  assert.equal(buildPrompt({ number: 3, title: 'T', body: null }), '/team Issue #3 : T');
  assert.equal(buildPrompt({ number: 3, title: 'T', body: ' a\r\nb ' }), '/team Issue #3 : T\n\na\nb');
  const exact = buildPrompt({ number: 3, title: 'T', body: 'a'.repeat(MAX_BODY) });
  assert.equal(exact, `/team Issue #3 : T\n\n${'a'.repeat(MAX_BODY)}`, 'à la limite exacte : pas de suffixe');
  const cut = buildPrompt({ number: 3, title: 'T', body: 'a'.repeat(MAX_BODY + 1) });
  assert.equal(cut, `/team Issue #3 : T\n\n${'a'.repeat(MAX_BODY)}\n[…corps de l'issue tronqué]`);
});

// --- missingSections --------------------------------------------------------

test('missingSections : corps vide ou null → les trois libellés', () => {
  assert.deepEqual(missingSections(''), LABELS);
  assert.deepEqual(missingSections(null), LABELS);
  assert.deepEqual(missingSections(undefined), LABELS);
  assert.deepEqual(missingSections('Un simple texte sans titre.'), LABELS);
});

test('missingSections : trois rubriques remplies → aucune manquante', () => {
  assert.deepEqual(missingSections(READY_BODY), []);
  assert.deepEqual(missingSections(READY_BODY.replace(/\n/g, '\r\n')), []);
});

test('missingSections : rubrique vide ou ne contenant qu\'un commentaire HTML → manquante', () => {
  const body = '## Objectif\n<!-- à remplir -->\n\n## Comportement attendu ou critères\nok\n\n## Hors périmètre\n';
  assert.deepEqual(missingSections(body), ['Objectif', 'Hors périmètre']);
  const open = '## Objectif\nok\n## Comportement attendu\nok\n## Hors périmètre\n<!-- jamais fermé\nLe reste';
  assert.deepEqual(missingSections(open), ['Hors périmètre']);
  const hidden = '<!--\n## Objectif\nfaux\n-->\n## Comportement attendu\nok\n## Hors périmètre\nok';
  assert.deepEqual(missingSections(hidden), ['Objectif']);
});

test('missingSections : variantes de titre (casse, accents, niveau, deux-points, suffixe)', () => {
  const body = '# OBJECTIF :\nx\n### Critères d\'acceptation :\n- y\n#### hors perimetre\nz';
  assert.deepEqual(missingSections(body), []);
  assert.deepEqual(missingSections('## Comportement attendu\nx'), [LABELS[0], LABELS[2]]);
  assert.deepEqual(missingSections('**Objectif**\nx\n## Criteres\nx\n## Hors périmètre\nx'), [LABELS[0]], 'le gras n\'est pas un titre');
});

test('missingSections : un sous-titre compte comme contenu, un titre de même niveau clôt la rubrique', () => {
  const sub = '## Objectif\n### Détail\n## Comportement attendu\nx\n## Hors périmètre\ny';
  assert.deepEqual(missingSections(sub), [], 'le sous-titre est du contenu');
  const same = '## Objectif\n## Comportement attendu\nx\n## Hors périmètre\ny';
  assert.deepEqual(missingSections(same), ['Objectif']);
  const lower = '### Objectif\n## Comportement attendu\nx\n## Hors périmètre\ny';
  assert.deepEqual(missingSections(lower), ['Objectif'], 'un titre de niveau inférieur ou égal clôt la rubrique');
});

test('missingSections : analyse le texte retenu — rubrique après 4 000 caractères → manquante', () => {
  const body = `## Objectif\n${'x'.repeat(MAX_BODY)}\n## Comportement attendu\nx\n## Hors périmètre\ny`;
  assert.deepEqual(missingSections(body), [LABELS[1], LABELS[2]]);
});

test('missingSections : titre hostile (espaces puis \\r ou \\u2028) analysé en temps borné', () => {
  // Régression ReDoS : « # a » + 3 990 espaces + séparateur que split('\n') laisse dans la ligne.
  for (const sep of ['\r', '\u2028', '\u2029', '#']) {
    const body = `# a${' '.repeat(3990)}${sep}x`;
    const start = performance.now();
    assert.deepEqual(missingSections(body), LABELS);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `séparateur ${JSON.stringify(sep)} : ${elapsed.toFixed(0)} ms`);
  }
  const start = performance.now();
  orderIssues([{ number: 1, body: `# a${' '.repeat(3990)}\rx`, labels: [] }]);
  assert.ok(performance.now() - start < 200, 'orderIssues sur une issue hostile');
});

test('missingSections : séquence de fermeture retirée, titre vide, ligne contenant \\r', () => {
  const closed = '## Objectif ##\nx\n## Critères\t##\t\ny\n## Hors périmètre #\nz';
  assert.deepEqual(missingSections(closed), []);
  assert.deepEqual(missingSections('## Objectif#\nx'), [LABELS[1], LABELS[2]], '« Objectif# » reste un titre commençant par l\'alias');
  assert.deepEqual(missingSections('## Objectif\rsuite\nx\n## Critères\ny\n## Hors périmètre\nz'), [], '\\r isolé dans un titre');
  assert.deepEqual(missingSections('####### Objectif\nx\n## Critères\ny\n## Hors périmètre\nz'), [LABELS[0]], 'sept # : pas un titre');
  assert.deepEqual(missingSections('## Objectif\n##\nx\n## Critères\ny\n## Hors périmètre\nz'), [LABELS[0]], 'un titre vide clôt la rubrique');
});

// --- dependencyRefs ---------------------------------------------------------

test('dependencyRefs : références lisibles, triées, sans doublon', () => {
  assert.deepEqual(dependencyRefs('Dépend de #12'), { numbers: [12], unreadable: [] });
  assert.deepEqual(dependencyRefs('dépend de #12 et #14'), { numbers: [12, 14], unreadable: [] });
  assert.deepEqual(dependencyRefs('DEPEND DE #14, #12\nDépend de #12'), { numbers: [12, 14], unreadable: [] });
  assert.deepEqual(dependencyRefs('Dépend de (#7); voir aussi #99'), { numbers: [7, 99], unreadable: [] });
  assert.deepEqual(dependencyRefs(null), { numbers: [], unreadable: [] });
  assert.deepEqual(dependencyRefs('Voir #5, sans mot-clé'), { numbers: [], unreadable: [] });
});

test('dependencyRefs : références illisibles → extrait ≤ 80 caractères', () => {
  assert.deepEqual(dependencyRefs('Dépend de la migration'), { numbers: [], unreadable: ['Dépend de la migration'] });
  const cross = dependencyRefs('Dépend de o/r#3');
  assert.deepEqual(cross.numbers, []);
  assert.equal(cross.unreadable.length, 1);
  assert.match(cross.unreadable[0], /o\/r#3/);
  const long = dependencyRefs(`Dépend de ${'a'.repeat(200)}`);
  assert.ok(long.unreadable[0].length <= 80);
  const mixed = dependencyRefs('Dépend de #12 et o/r#3');
  assert.deepEqual(mixed.numbers, [12]);
  assert.equal(mixed.unreadable.length, 1);
});

test('dependencyRefs : une référence dans un commentaire HTML est ignorée', () => {
  assert.deepEqual(dependencyRefs('<!-- Dépend de #12 -->\nTexte'), { numbers: [], unreadable: [] });
  assert.deepEqual(dependencyRefs('<!-- Dépend de #12\nsans fin'), { numbers: [], unreadable: [] });
  assert.deepEqual(dependencyRefs('Dépend de #3 <!-- #4 -->'), { numbers: [3], unreadable: [] });
});

// --- priorityRank -----------------------------------------------------------

const labeled = (...names) => ({ number: 1, labels: names.map((name) => ({ name })) });

test('priorityRank : P0 < P1 < P2 < sans label', () => {
  const rank = (...names) => priorityRank(labeled(...names), DEFAULT_PRIORITY_LABELS);
  assert.ok(rank('P0') < rank('P1'));
  assert.ok(rank('P1') < rank('P2'));
  assert.ok(rank('P2') < rank('bug'));
  assert.equal(rank('bug'), 3);
  assert.equal(priorityRank({ number: 1 }, DEFAULT_PRIORITY_LABELS), 3);
  assert.equal(priorityRank({ number: 1, labels: null }, DEFAULT_PRIORITY_LABELS), 3);
});

test('priorityRank : labels personnalisés, plusieurs labels → le plus prioritaire, noms en texte accepté', () => {
  assert.equal(priorityRank(labeled('haute'), ['urgent', 'haute']), 1);
  assert.equal(priorityRank(labeled('P1'), ['urgent', 'haute']), 2);
  assert.equal(priorityRank(labeled('P2', 'P0', 'bug'), DEFAULT_PRIORITY_LABELS), 0);
  assert.equal(priorityRank({ number: 1, labels: ['P1'] }, DEFAULT_PRIORITY_LABELS), 1);
});

// --- orderIssues ------------------------------------------------------------

const issue = (number, extra = {}) => ({
  number, body: READY_BODY, created_at: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`, labels: [], ...extra,
});
const order = (issues, depStates = new Map()) => orderIssues(issues, { priorityLabels: DEFAULT_PRIORITY_LABELS, depStates });

test('orderIssues : priorité, puis created_at, puis numéro — indépendant de l\'ordre d\'entrée', () => {
  const issues = [
    issue(5, { labels: [{ name: 'P2' }] }),
    issue(4),
    issue(3, { labels: [{ name: 'P1' }], created_at: '2026-03-01T00:00:00Z' }),
    issue(2, { labels: [{ name: 'P1' }], created_at: '2026-02-01T00:00:00Z' }),
    issue(1, { labels: [{ name: 'P0' }], created_at: '2026-09-01T00:00:00Z' }),
    issue(6, { created_at: '2026-01-04T00:00:00Z' }),
  ];
  const expected = [1, 2, 3, 5, 4, 6];
  assert.deepEqual(order(issues).ready.map((i) => i.number), expected);
  assert.deepEqual(order([...issues].reverse()).ready.map((i) => i.number), expected);
  assert.deepEqual(order([issues[3], issues[0], issues[5], issues[1], issues[4], issues[2]]).ready.map((i) => i.number), expected);
});

test('orderIssues : même priorité → la plus ancienne d\'abord, même si son numéro est plus grand', () => {
  const older = issue(9, { created_at: '2026-01-01T00:00:00Z' });
  const newer = issue(3, { created_at: '2026-02-01T00:00:00Z' });
  assert.deepEqual(order([newer, older]).ready.map((i) => i.number), [9, 3]);
  assert.deepEqual(order([older, newer]).ready.map((i) => i.number), [9, 3]);
  const p1 = { labels: [{ name: 'P1' }] };
  assert.deepEqual(order([{ ...newer, ...p1 }, { ...older, ...p1 }]).ready.map((i) => i.number), [9, 3]);
});

test('orderIssues : même priorité et même date → numéro croissant', () => {
  const same = { created_at: '2026-05-01T00:00:00Z' };
  assert.deepEqual(order([issue(9, same), issue(3, same), issue(5, same)]).ready.map((i) => i.number), [3, 5, 9]);
});

test('orderIssues : issue non prête → raison exacte avec les rubriques manquantes', () => {
  const result = order([issue(7, { body: '## Comportement attendu\nx' }), issue(8)]);
  assert.deepEqual(result.ready.map((i) => i.number), [8]);
  assert.deepEqual(result.skipped, [{
    number: 7, kind: 'not_ready', reason: 'issue non prête : Objectif, Hors périmètre', missing: ['Objectif', 'Hors périmètre'],
  }]);
  assert.deepEqual(order([issue(9, { body: null })]).skipped[0].missing, LABELS);
});

test('orderIssues : dépendance ouverte → écartée ; fermée → prête ; inconnue ou illisible → avertissement et prête', () => {
  const dep = (body) => ({ ...issue(10), body: `${READY_BODY}\n${body}` });
  const open = new Map([[4, { state: 'open', body: READY_BODY }]]);
  const closed = new Map([[4, { state: 'closed', body: '' }]]);

  const blocked = order([dep('Dépend de #4')], open);
  assert.deepEqual(blocked.ready, []);
  assert.deepEqual(blocked.skipped, [{ number: 10, kind: 'dependency', reason: 'dépend de #4 (ouverte)' }]);

  const fine = order([dep('Dépend de #4')], closed);
  assert.deepEqual(fine.ready.map((i) => i.number), [10]);
  assert.deepEqual(fine.warnings, []);

  const unknown = order([dep('Dépend de #4')], new Map());
  assert.deepEqual(unknown.ready.map((i) => i.number), [10]);
  assert.equal(unknown.warnings.length, 1);
  assert.equal(unknown.warnings[0].number, 10);
  assert.match(unknown.warnings[0].message, /#4/);

  const unreadable = order([dep('Dépend de la migration')], closed);
  assert.deepEqual(unreadable.ready.map((i) => i.number), [10]);
  assert.equal(unreadable.warnings.length, 1);
  assert.match(unreadable.warnings[0].message, /migration/);
});

test('orderIssues : une dépendance sur une issue de la liste elle-même ouverte écarte l\'issue', () => {
  const a = issue(1);
  const b = { ...issue(2), body: `${READY_BODY}\nDépend de #1` };
  const result = order([b, a]);
  assert.deepEqual(result.ready.map((i) => i.number), [1]);
  assert.deepEqual(result.skipped, [{ number: 2, kind: 'dependency', reason: 'dépend de #1 (ouverte)' }]);
});

test('orderIssues : cycle A↔B et dépendance sur soi-même → kind cycle', () => {
  const withDep = (number, dep) => ({ ...issue(number), body: `${READY_BODY}\nDépend de #${dep}` });
  const pair = order([withDep(1, 2), withDep(2, 1)]);
  assert.deepEqual(pair.ready, []);
  assert.deepEqual(pair.skipped, [
    { number: 1, kind: 'cycle', reason: 'dépendances en cycle : #1 → #2 → #1' },
    { number: 2, kind: 'cycle', reason: 'dépendances en cycle : #2 → #1 → #2' },
  ]);
  const self = order([withDep(3, 3)]);
  assert.deepEqual(self.skipped, [{ number: 3, kind: 'cycle', reason: 'dépendances en cycle : #3 → #3' }]);

  // Un cycle traversant une issue hors liste, connue ouverte par depStates.
  const states = new Map([[9, { state: 'open', body: `${READY_BODY}\nDépend de #4` }]]);
  const via = order([withDep(4, 9)], states);
  assert.equal(via.skipped[0].kind, 'cycle');
  assert.equal(via.skipped[0].reason, 'dépendances en cycle : #4 → #9 → #4');

  // Une issue qui dépend d'un cycle sans en faire partie est simplement bloquée.
  const tail = order([withDep(1, 2), withDep(2, 1), withDep(5, 1)]);
  assert.equal(tail.skipped.find((s) => s.number === 5).kind, 'dependency');
});

// --- resolveDependencyStates ------------------------------------------------

const withDeps = (number, ...deps) => ({ ...issue(number), body: `${READY_BODY}\nDépend de ${deps.map((d) => `#${d}`).join(' et ')}` });

test('resolveDependencyStates : états connus sans appel, fetch pour les autres', () => {
  const calls = [];
  const fetchIssue = (n) => {
    calls.push(n);
    return { state: 'closed', body: `corps ${n}` };
  };
  const states = resolveDependencyStates([issue(1), withDeps(2, 1, 8), withDeps(3, 8, 9)], fetchIssue);
  assert.deepEqual(calls, [8, 9]);
  assert.equal(states.get(1).state, 'open', 'issue reçue : connue, ouverte');
  assert.deepEqual(states.get(8), { state: 'closed', body: 'corps 8' });
  assert.deepEqual(states.get(9), { state: 'closed', body: 'corps 9' });
});

test('resolveDependencyStates : échec ou exception → absent', () => {
  const fetchIssue = (n) => {
    if (n === 8) return null;
    throw new Error('réseau');
  };
  const states = resolveDependencyStates([withDeps(2, 8, 9)], fetchIssue);
  assert.equal(states.has(8), false);
  assert.equal(states.has(9), false);
});

test('resolveDependencyStates : plafond max respecté (20 par défaut)', () => {
  const many = withDeps(1, ...Array.from({ length: 30 }, (_, i) => 100 + i));
  let count = 0;
  const fetchIssue = () => {
    count += 1;
    return { state: 'closed', body: '' };
  };
  resolveDependencyStates([many], fetchIssue);
  assert.equal(count, 20);
  count = 0;
  const states = resolveDependencyStates([many], fetchIssue, { max: 3 });
  assert.equal(count, 3);
  assert.deepEqual([...states.keys()].filter((n) => n >= 100), [100, 101, 102]);
});

test('resolveDependencyStates : le plafond sert d\'abord les issues les plus prioritaires, puis les plus anciennes', () => {
  const calls = [];
  const fetchIssue = (n) => {
    calls.push(n);
    return { state: 'open', body: '' };
  };
  const old = Array.from({ length: 25 }, (_, i) => withDeps(i + 1, 200 + i));
  const urgent = { ...withDeps(50, 999), labels: [{ name: 'P0' }], created_at: '2026-09-01T00:00:00Z' };
  // Entrée dans l'ordre inverse de l'ancienneté, P0 en dernier : seul le tri place #999 en tête.
  const states = resolveDependencyStates([...[...old].reverse(), urgent], fetchIssue);
  assert.equal(calls.length, 20);
  assert.equal(calls[0], 999, 'la dépendance de la P0 est lue en premier');
  assert.deepEqual(calls.slice(1), Array.from({ length: 19 }, (_, i) => 200 + i), 'puis par ancienneté');
  assert.deepEqual(order([...old, urgent], states).skipped.find((s) => s.number === 50),
    { number: 50, kind: 'dependency', reason: 'dépend de #999 (ouverte)' });

  // Labels personnalisés : même rang que orderIssues.
  calls.length = 0;
  const custom = [withDeps(1, 300), { ...withDeps(2, 301), labels: [{ name: 'urgent' }] }];
  resolveDependencyStates(custom, fetchIssue, { max: 1, priorityLabels: ['urgent'] });
  assert.deepEqual(calls, [301]);
});

// --- backlogConfig ----------------------------------------------------------

test('backlogConfig : priorityLabels par défaut, personnalisé (espaces retirées), invalide → défaut', () => {
  assert.deepEqual(backlogConfig({}).priorityLabels, ['P0', 'P1', 'P2']);
  assert.deepEqual(backlogConfig({ backlog: { priorityLabels: [' urgent ', 'normal'] } }).priorityLabels, ['urgent', 'normal']);
  for (const bad of [[], ['P0', ''], ['P0', 'P0'], 'P0', [1], null]) {
    assert.deepEqual(backlogConfig({ backlog: { priorityLabels: bad } }).priorityLabels, ['P0', 'P1', 'P2'], JSON.stringify(bad));
  }
  const config = backlogConfig({});
  config.priorityLabels.push('X');
  assert.deepEqual(DEFAULT_PRIORITY_LABELS, ['P0', 'P1', 'P2'], 'la constante n\'est pas partagée par référence');
});
