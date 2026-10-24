import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatFinding } from '../template/.claude/skills/team-audit/scripts/create-issues.mjs';

// --- formatFinding (pur, sans gh) ---

test('formatFinding : constat valide → title et body', () => {
  const result = formatFinding({
    issueTitle: 'Faille XSS dans le formulaire',
    issueBody: '## Objectif\n\nCorrection.\n\n## Comportement attendu ou critères\n\n- OK\n\n## Hors périmètre\n\n- Rien',
  });
  assert.equal(result.title, 'Faille XSS dans le formulaire');
  assert.match(result.body, /## Objectif/);
});

test('formatFinding : issueTitle manquant → erreur', () => {
  assert.throws(() => formatFinding({ issueBody: 'x' }), /issueTitle/);
});

test('formatFinding : issueBody manquant → erreur', () => {
  assert.throws(() => formatFinding({ issueTitle: 'x' }), /issueBody/);
});

test('formatFinding : issueTitle vide → erreur', () => {
  assert.throws(() => formatFinding({ issueTitle: '  ', issueBody: 'x' }), /issueTitle/);
});

test('formatFinding : constat null → erreur', () => {
  assert.throws(() => formatFinding(null), /objet/);
});

test('formatFinding : entrée non objet → erreur', () => {
  assert.throws(() => formatFinding('pas un objet'), /objet/);
});
