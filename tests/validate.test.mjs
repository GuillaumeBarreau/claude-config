import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { install } from '../install.mjs';
import { parseFrontmatter, splitList, validate } from '../validate.mjs';
import { TEMPLATE_CLAUDE, TEMPLATE_ROOT, tempDir, templateCopy, writeFile } from './helpers.mjs';

const replaceIn = (path, from, to) => {
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(from), `« ${from} » absent de ${path}`);
  writeFileSync(path, text.replace(from, to));
};
const errorsOf = (root) => validate(root).errors.join('\n');

test('le template du dépôt est valide', () => {
  const { errors } = validate(TEMPLATE_ROOT);
  assert.deepEqual(errors, []);
});

test('frontmatter : scalaires, guillemets et listes', () => {
  const fm = parseFrontmatter('---\nname: "cc-planner"\ntools: Read, Grep\nskills:\n  - team-rules\n  - autre\n---\ncorps');
  assert.equal(fm.data.name, 'cc-planner');
  assert.deepEqual(splitList(fm.data.tools), ['Read', 'Grep']);
  assert.deepEqual(fm.data.skills, ['team-rules', 'autre']);
  assert.equal(fm.body, 'corps');
  assert.equal(parseFrontmatter('pas de frontmatter'), null);
  assert.equal(parseFrontmatter('---\nname: x\n'), null);
});

test('splitList garde les parenthèses intactes', () => {
  assert.deepEqual(splitList('Bash(git add *) Bash(git status *), Read'), ['Bash(git add *)', 'Bash(git status *)', 'Read']);
});

test('agent sans model : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/cc-planner.md'), 'model: opus\n', '');
  assert.match(errorsOf(root), /cc-planner\.md : clé obligatoire « model »/);
});

test('effort inconnu : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/cc-planner.md'), 'effort: high', 'effort: extreme');
  assert.match(errorsOf(root), /effort « extreme » inconnu/);
});

test('outils en joker : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/cc-planner.md'), 'tools: Read, Grep, Glob, Bash', 'tools: *');
  assert.match(errorsOf(root), /tools « \* »/);
});

test('name différent du nom de fichier : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/cc-planner.md'), 'name: cc-planner', 'name: cc-architect');
  assert.match(errorsOf(root), /name « cc-architect » ≠ nom du fichier/);
});

test('skill préchargée absente : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/cc-planner.md'), '  - team-rules', '  - inexistante');
  assert.match(errorsOf(root), /skill préchargée « inexistante » introuvable/);
});

test('skill préchargée avec disable-model-invocation : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/team-rules/SKILL.md'), 'user-invocable: false', 'disable-model-invocation: true');
  assert.match(errorsOf(root), /empêche son préchargement/);
});

test('lien cassé dans une skill : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/team/SKILL.md'), '](workflow.md)', '](absent.md)');
  assert.match(errorsOf(root), /lien vers « absent\.md » introuvable/);
});

test('skill dont le name ne correspond pas au dossier : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/team/SKILL.md'), 'name: team\n', 'name: orchestrator\n');
  assert.match(errorsOf(root), /name « orchestrator » ≠ dossier « team »/);
});

test('allowed-tools en joker : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/which-surface/SKILL.md'), 'allowed-tools: Read, Grep, Glob', 'allowed-tools: Bash(*)');
  assert.match(errorsOf(root), /accorde « Bash\(\*\) » sans restriction/);
});

test('team.json : agent activé sans fichier, contrôle incomplet, JSON invalide', () => {
  const root = templateCopy();
  const path = join(root, '.claude/team.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.agents["release-manager"] = true;
  config.checks = [{ name: 'tests', command: 'pytest' }];
  writeFileSync(path, JSON.stringify(config));
  const errors = errorsOf(root);
  assert.match(errors, /agent « release-manager » activé mais agents\/release-manager\.md absent/);
  assert.match(errors, /checks\[0\] doit avoir name, command et required/);

  writeFileSync(path, '{ invalide');
  assert.match(errorsOf(root), /team\.json : JSON invalide/);
});

test('settings.json invalide : erreur', () => {
  const root = templateCopy();
  writeFile(join(root, '.claude/settings.json'), '{ "hooks": ');
  assert.match(errorsOf(root), /settings\.json : JSON invalide/);
});

test('frontmatter : liste en ligne et texte replié', () => {
  const fm = parseFrontmatter('---\ntools: [Read, "Grep"]\ndescription: >-\n  Relit le code\n  et rend un verdict\nvide: |\nname: x\n---\n');
  assert.deepEqual(fm.data.tools, ['Read', 'Grep']);
  assert.equal(fm.data.description, 'Relit le code et rend un verdict');
  assert.equal(fm.data.vide, '');
  assert.equal(fm.data.name, 'x');
});

test('description repliée vide : erreur', () => {
  const root = templateCopy();
  const path = join(root, '.claude/agents/cc-planner.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^description: .*$/m, 'description: >-'));
  assert.match(errorsOf(root), /cc-planner\.md : clé obligatoire « description »/);
});

test('un lien dans un bloc de code n\'est pas vérifié', () => {
  const root = templateCopy();
  const path = join(root, '.claude/skills/team/SKILL.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nExemple : `[a](absent.md)`\n\n```\n[b](absent2.md)\n```\n');
  assert.deepEqual(validate(root).errors, []);
});

test('projet installé : un agent propre au projet minimal ne fait pas échouer la validation', () => {
  const projectDir = tempDir('projet-');
  install({ templateDir: TEMPLATE_CLAUDE, projectDir, version: 'test' });
  writeFile(join(projectDir, '.claude/agents/mon-agent.md'), '---\nname: mon-agent\ndescription: Agent du projet\n---\nCorps\n');
  writeFile(join(projectDir, '.claude/skills/ma-skill/SKILL.md'), 'Pas de frontmatter\n');
  const { errors, warnings } = validate(projectDir);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /ma-skill\/SKILL\.md : pas de frontmatter/);

  // Un agent installé par claude-config reste tenu aux règles strictes.
  replaceIn(join(projectDir, '.claude/agents/cc-planner.md'), 'effort: high\n', '');
  assert.match(errorsOf(projectDir), /cc-planner\.md : clé obligatoire « effort »/);
});

test('corps d\'agent trop long : avertissement seulement', () => {
  const root = templateCopy();
  const path = join(root, '.claude/agents/cc-planner.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nligne'.repeat(120));
  const { errors, warnings } = validate(root);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /cc-planner\.md : corps de \d+ lignes/);
});

test('settings.json : un hook dont le script n\'existe pas est une erreur', () => {
  const root = templateCopy();
  rmSync(join(root, '.claude/hooks/team/guard-bash.mjs'));
  assert.match(errorsOf(root), /settings\.json : hook PreToolUse → « \.claude\/hooks\/team\/guard-bash\.mjs » introuvable/);
});

test('settings.json : événement de hook inconnu signalé', () => {
  const root = templateCopy();
  const path = join(root, '.claude/settings.json');
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  settings.hooks.BeforeTool = settings.hooks.PreToolUse;
  writeFileSync(path, JSON.stringify(settings));
  assert.match(validate(root).warnings.join('\n'), /événement de hook « BeforeTool » inconnu/);
});

test('team.json : autonomy hors liste', () => {
  const root = templateCopy();
  const path = join(root, '.claude/team.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), autonomy: 'yolo' }));
  assert.match(errorsOf(root), /team\.json : « autonomy » doit valoir supervised ou autonomous/);
});

test('team.json : pullRequest mal typé ou titlePattern invalide', () => {
  const root = templateCopy();
  const path = join(root, '.claude/team.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, pullRequest: { draft: 'oui', maxChangedLines: -1, titlePattern: '(feat', labels: 'bug' } }));
  const errors = errorsOf(root);
  assert.match(errors, /pullRequest\.draft : doit être true ou false/);
  assert.match(errors, /pullRequest\.maxChangedLines : doit être un entier > 0/);
  assert.match(errors, /pullRequest\.titlePattern : expression régulière invalide/);
  assert.match(errors, /pullRequest\.labels : doit être une liste/);
});

// --- Clés facultatives de team.json (contrat §2.4, lot D) ---

const withTeam = (patch) => {
  const root = templateCopy();
  const path = join(root, '.claude/team.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }));
  return root;
};

test('team.json : le modèle déclare les valeurs par défaut des clés facultatives', () => {
  const config = JSON.parse(readFileSync(join(TEMPLATE_CLAUDE, 'team.json'), 'utf8'));
  assert.deepEqual(config.sensitivePaths, []);
  assert.equal(config.escalationModel, 'opus');
  assert.deepEqual(Object.keys(config.ci).sort(), ['enabled', 'maxFixRounds', 'timeoutMinutes']);
  assert.deepEqual(config.prComments.allowedAssociations, ['OWNER', 'MEMBER', 'COLLABORATOR']);
  assert.deepEqual(Object.keys(config.lessons).sort(), ['enabled', 'maxEntries']);
  assert.equal(config.backlog.draftPr, false);
  assert.deepEqual(config.parallel, { enabled: false });
  assert.deepEqual(config.review, {
    language: 'fr', event: 'COMMENT', maxInlineCould: 5, architectureMinLines: 150,
    axes: { frontend: [], backend: [] }, batch: { maxPrs: 3 },
  });
});

test('team.json : section review — chaque valeur mal typée est signalée', () => {
  const errors = errorsOf(withTeam({ review: {
    language: '', event: 'MERGE', maxInlineCould: 0, architectureMinLines: 1.5,
    axes: { frontend: 'ui/**', backend: ['server/**', ''], mobile: ['ios/**'] }, batch: { maxPrs: -1 },
  } }));
  for (const re of [
    /review\.language : doit être un texte non vide/,
    /review\.event : « MERGE » inconnu \(COMMENT, APPROVE, REQUEST_CHANGES\)/,
    /review\.maxInlineCould : doit être un entier > 0/,
    /review\.architectureMinLines : doit être un entier > 0/,
    /review\.axes\.frontend : doit être une liste de motifs/,
    /review\.axes\.backend : doit être une liste de motifs/,
    /review\.axes\.mobile : axe inconnu \(frontend, backend\)/,
    /review\.batch\.maxPrs : doit être un entier > 0/,
  ]) {
    assert.match(errors, re);
  }
  const shapes = errorsOf(withTeam({ review: { axes: ['ui/**'], batch: 3 } }));
  assert.match(shapes, /review\.axes : doit être un objet/);
  assert.match(shapes, /review\.batch : doit être un objet/);
  assert.match(errorsOf(withTeam({ review: 'fr' })), /team\.json : review : doit être un objet/);
});

test('team.json : section review valide ou absente', () => {
  for (const review of [
    undefined, {}, { event: 'APPROVE' }, { event: 'REQUEST_CHANGES', maxInlineCould: 1 },
    { axes: { frontend: ['ui/**', 'shared/**'], backend: [] } }, { axes: {}, batch: {} },
  ]) {
    assert.doesNotMatch(errorsOf(withTeam({ review })), /review/, JSON.stringify(review));
  }
});

test('team.json : chaque clé facultative mal typée est signalée', () => {
  const errors = errorsOf(withTeam({
    sensitivePaths: 'migrations/**',
    escalationModel: 'gpt',
    ci: { enabled: 'oui', timeoutMinutes: 0, maxFixRounds: -1 },
    prComments: { allowedAssociations: ['OWNER', 'EVERYONE'] },
    lessons: { enabled: 1, maxEntries: 0 },
    backlog: { label: '', draftPr: 'non', maxIssues: 1.5, maxBudgetUsd: 0 },
    parallel: { enabled: 'non' },
  }));
  for (const re of [
    /sensitivePaths : doit être une liste de motifs/,
    /escalationModel : « gpt » inconnu/,
    /ci\.enabled : doit être true ou false/,
    /ci\.timeoutMinutes : doit être un entier > 0/,
    /ci\.maxFixRounds : doit être un entier ≥ 0/,
    /prComments\.allowedAssociations : « EVERYONE » inconnue/,
    /lessons\.enabled : doit être true ou false/,
    /lessons\.maxEntries : doit être un entier > 0/,
    /backlog\.label : doit être un texte non vide/,
    /backlog\.draftPr : doit être true ou false/,
    /backlog\.maxIssues : doit être un entier > 0/,
    /backlog\.maxBudgetUsd : doit être un nombre > 0/,
    /parallel\.enabled : doit être true ou false/,
  ]) {
    assert.match(errors, re);
  }
});

test('team.json : backlog.priorityLabels doit être une liste non vide de textes non vides, sans doublon', () => {
  const message = /team\.json : backlog\.priorityLabels : doit être une liste non vide de textes non vides, sans doublon/;
  for (const bad of [[], ['P0', ''], ['P0', 'P0'], ['P0', ' P0 '], 'P0', [1], null]) {
    assert.match(errorsOf(withTeam({ backlog: { priorityLabels: bad } })), message, JSON.stringify(bad));
  }
  for (const good of [['P0', 'P1', 'P2'], ['urgent']]) {
    assert.doesNotMatch(errorsOf(withTeam({ backlog: { priorityLabels: good } })), /priorityLabels/, JSON.stringify(good));
  }
  assert.doesNotMatch(errorsOf(withTeam({ backlog: {} })), /priorityLabels/, 'clé facultative');
});

test('team.json : sections facultatives qui ne sont pas des objets, motifs vides', () => {
  const errors = errorsOf(withTeam({ ci: true, prComments: [], lessons: 'oui', backlog: null, parallel: 1, sensitivePaths: ['ok/**', ''] }));
  for (const key of ['ci', 'prComments', 'lessons', 'backlog', 'parallel']) {
    assert.match(errors, new RegExp(`team\\.json : ${key} : doit être un objet`));
  }
  assert.match(errors, /sensitivePaths : doit être une liste de motifs/);
});

test('team.json : parallel.enabled à true est réservé (avertissement)', () => {
  const { errors, warnings } = validate(withTeam({ parallel: { enabled: true } }));
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /parallel\.enabled : réservé/);
});

test('team.json : escalationModel accepte un identifiant claude-*', () => {
  assert.deepEqual(validate(withTeam({ escalationModel: 'claude-opus-5-5' })).errors, []);
});

test('team.json : cc-implementer ne peut pas être désactivé (agent par défaut et de repli)', () => {
  const root = templateCopy();
  const path = join(root, '.claude/team.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.agents['cc-implementer'] = false;
  writeFileSync(path, JSON.stringify(config));
  assert.match(errorsOf(root), /team\.json : agent « cc-implementer » ne peut pas être désactivé/);
});

// --- Préfixe cc- des agents gérés par claude-config (ADR 0012) ---

const AGENT_FILE = '---\nname: NAME\ndescription: Agent\ntools: Read\nmodel: sonnet\neffort: low\n---\nCorps\n';

test('agent géré par claude-config sans préfixe cc- : erreur (template)', () => {
  const root = templateCopy();
  const from = join(root, '.claude/agents/cc-planner.md');
  writeFileSync(join(root, '.claude/agents/planner.md'), readFileSync(from, 'utf8').replace('name: cc-planner', 'name: planner'));
  rmSync(from);
  assert.match(errorsOf(root), /agents\/planner\.md : nom « planner » sans préfixe « cc- »/);
});

test('projet installé : le préfixe cc- n\'est exigé que des agents du manifeste', () => {
  const projectDir = tempDir('projet-');
  install({ templateDir: TEMPLATE_CLAUDE, projectDir, version: 'test' });
  writeFile(join(projectDir, '.claude/agents/code-reviewer.md'), AGENT_FILE.replace('NAME', 'code-reviewer'));
  assert.doesNotMatch(errorsOf(projectDir), /préfixe/);

  const manifestPath = join(projectDir, '.claude/claude-config.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files['agents/legacy.md'] = 'empreinte';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFile(join(projectDir, '.claude/agents/legacy.md'), AGENT_FILE.replace('NAME', 'legacy'));
  const errors = errorsOf(projectDir);
  assert.match(errors, /agents\/legacy\.md : nom « legacy » sans préfixe « cc- »/);
  assert.doesNotMatch(errors, /code-reviewer\.md : nom/);
});

test('team.json : une ancienne clé agents.<nom> est signalée avec le nouveau nom', () => {
  const root = templateCopy();
  const path = join(root, '.claude/team.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.agents.implementer = true;
  config.agents['pr-verifier'] = false;
  writeFileSync(path, JSON.stringify(config));
  const errors = errorsOf(root);
  assert.match(errors, /team\.json : agents\.implementer : ancien nom, renomme la clé en « cc-implementer »/);
  assert.match(errors, /team\.json : agents\.pr-verifier : ancien nom, renomme la clé en « cc-pr-verifier »/);
  assert.doesNotMatch(errors, /agent « implementer » activé mais/);
});
