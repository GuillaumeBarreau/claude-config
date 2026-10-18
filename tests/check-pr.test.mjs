import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkPr } from '../template/.claude/skills/team/scripts/check-pr.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

const GOOD_PR = `# feat: export CSV des sessions (filtre par date)

## Résumé

Les utilisateurs ne pouvaient pas exporter leurs sessions. La PR ajoute un export CSV
filtrable par date.

## Changements

- \`src/export.ts\` : génération du CSV.

## Décisions techniques

- Écriture en flux — évite de charger toutes les sessions en mémoire.

## Vérification

| Contrôle | Commande | Statut |
| -------- | -------- | ------ |
| tests    | \`pytest\` | passed |

Critères d'acceptation : AC1 couvert par \`tests/test_export.py:12\`.

## Risques et migrations

- Aucun.

## À vérifier par l'humain

- Le libellé du bouton.

Run : \`.agent-runs/2026-10-18-exemple/\`
`;

/** Run terminé : contrôles réussis, une tâche couvrant AC1. */
function setup(pr = GOOD_PR, teamPatch = {}) {
  const root = templateCopy();
  const claudeDir = join(root, '.claude');
  const teamPath = join(claudeDir, 'team.json');
  writeFileSync(teamPath, JSON.stringify({ ...JSON.parse(readFileSync(teamPath, 'utf8')), ...teamPatch }));
  const state = JSON.parse(readFileSync(join(claudeDir, 'skills/team/templates/state.json'), 'utf8'));
  state.checks[0].status = 'passed';
  const runDir = join(root, '.agent-runs', state.id);
  writeFile(join(runDir, 'state.json'), JSON.stringify(state));
  writeFile(join(runDir, 'pr.md'), pr);
  return { root, claudeDir, runDir, state };
}
const errorsOf = (pr, teamPatch) => {
  const { claudeDir, runDir } = setup(pr, teamPatch);
  return checkPr({ claudeDir, runDir }).errors.join('\n');
};

test('pr.md conforme : aucune erreur, titre et corps séparés pour gh', () => {
  const { claudeDir, runDir } = setup();
  const result = checkPr({ claudeDir, runDir });
  assert.deepEqual(result.errors, []);
  assert.equal(result.title, 'feat: export CSV des sessions (filtre par date)');
  const body = readFileSync(join(runDir, 'pr-body.md'), 'utf8');
  assert.ok(!body.includes('# feat:'));
  assert.match(body, /## Résumé/);
});

test('titre : absent, trop long, ou hors du format du projet', () => {
  assert.match(errorsOf(GOOD_PR.replace(/^# .*\n/, '')), /titre absent/);
  assert.match(errorsOf(GOOD_PR.replace(/^# .*/, `# feat: ${'x'.repeat(80)}`)), /titre de \d+ caractères \(> 72\)/);
  assert.match(errorsOf(GOOD_PR, { pullRequest: { titlePattern: '^(feat|fix)\\(\\w+\\): ' } }), /ne respecte pas le format/);
});

test('sections obligatoires', () => {
  assert.match(errorsOf(GOOD_PR.replace('## Risques et migrations', '## Divers')), /section « Risques et migrations » absente/);
});

test('modèle non rempli : texte entre chevrons refusé, sauf dans le code', () => {
  assert.match(errorsOf(GOOD_PR.replace('- Aucun.', '- <Aucun / description>')), /texte du modèle non remplacé : « <Aucun \/ description> »/);
  assert.deepEqual(errorsOf(GOOD_PR.replace('- Aucun.', '- Type `Array<string>` conservé.')), '');
});

test('vérification : chaque contrôle avec son statut réel', () => {
  assert.match(errorsOf(GOOD_PR.replace('| tests    | `pytest` | passed |\n', '')), /contrôle « tests » absent du tableau/);
  const { claudeDir, runDir, state } = setup();
  state.checks[0].status = 'failed';
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  assert.match(checkPr({ claudeDir, runDir }).errors.join('\n'), /« tests » annoncé passed alors que state\.json dit failed/);
});

test('critères d\'acceptation et lien vers le run', () => {
  assert.match(errorsOf(GOOD_PR.replace('AC1 couvert', 'Couvert')), /AC1 n'est pas mentionné/);
  assert.match(errorsOf(GOOD_PR.replace('2026-10-18-exemple', 'autre-run')), /lien vers le run/);
});

test('taille : avertissement au-delà de maxChangedLines, jamais d\'erreur', () => {
  const { root, claudeDir, runDir, state } = setup(GOOD_PR, { pullRequest: { maxChangedLines: 5 } });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('switch', '-q', '-c', 'team/x');
  writeFileSync(join(root, 'gros.txt'), 'ligne\n'.repeat(20));
  git('add', 'gros.txt');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'gros');
  state.branch = 'team/x';
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  const result = checkPr({ claudeDir, runDir });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /20 lignes modifiées \(> 5\)/);
});

test('ligne de commande : 0 si conforme, 1 sinon', () => {
  const ok = setup();
  const script = join(ok.claudeDir, 'skills/team/scripts/check-pr.mjs');
  assert.match(execFileSync(process.execPath, [script, ok.runDir], { encoding: 'utf8' }), /conforme/);
  const ko = setup(GOOD_PR.replace(/^# .*\n/, ''));
  assert.throws(() => execFileSync(process.execPath, [script, ko.runDir], { stdio: 'pipe' }), (err) => err.status === 1);
  assert.ok(!existsSync(join(ko.runDir, 'pr-body.md')));
});
