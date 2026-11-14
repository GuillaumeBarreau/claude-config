import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_IGNORE_ENTRY, EXCLUDE_BEGIN, EXCLUDE_END, GITIGNORE_ENTRY, hashOf, install, installedMode, main as installMain, MANIFEST, mergeSettings,
  migrateTeamAgents, REVIEWS_IGNORE_ENTRY,
} from '../install.mjs';
import { LEGACY_AGENTS } from '../template/.claude/skills/team/scripts/deliverable.mjs';
import { validate } from '../validate.mjs';
import { REPO_DIR, TEMPLATE_CLAUDE, tempDir, writeFile } from './helpers.mjs';

const byAction = (actions, action) => actions.filter((a) => a.action === action).map((a) => a.file);

/** Template modifiable + projet vide, pour simuler des évolutions du template. */
function setup() {
  const templateDir = join(tempDir(), '.claude');
  cpSync(TEMPLATE_CLAUDE, templateDir, { recursive: true });
  const projectDir = tempDir('projet-');
  const run = (opts = {}) => install({ templateDir, projectDir, version: 'test', ...opts });
  return { templateDir, projectDir, run };
}

test('première installation : tout est ajouté, la config installée est valide', () => {
  const { projectDir, run } = setup();
  const actions = run();
  assert.ok(byAction(actions, 'add').includes('agents/cc-planner.md'));
  assert.ok(byAction(actions, 'add').includes('team.json'));
  assert.deepEqual(byAction(actions, 'gitignore'), ['../.gitignore']);
  assert.deepEqual(byAction(actions, 'gitignore-reviews'), ['../.gitignore']);
  assert.ok(existsSync(join(projectDir, '.claude', MANIFEST)));
  assert.match(readFileSync(join(projectDir, '.gitignore'), 'utf8'), new RegExp(`^${GITIGNORE_ENTRY}$`, 'm'));
  assert.match(readFileSync(join(projectDir, '.gitignore'), 'utf8'), /^\.agent-reviews\/$/m);
  assert.deepEqual(validate(projectDir).errors, []);
});

test('réinstallation sans changement : rien ne bouge, .gitignore non dupliqué', () => {
  const { projectDir, run } = setup();
  run();
  const actions = run();
  assert.deepEqual(new Set(actions.map((a) => a.action)), new Set(['unchanged', 'keep']));
  const count = readFileSync(join(projectDir, '.gitignore'), 'utf8').split('\n').filter((l) => l === GITIGNORE_ENTRY).length;
  assert.equal(count, 1);
  assert.equal(readFileSync(join(projectDir, '.gitignore'), 'utf8').split('\n').filter((l) => l === REVIEWS_IGNORE_ENTRY).length, 1);
});

test('.gitignore existant sans saut de ligne final : entrée ajoutée sur sa propre ligne', () => {
  const { projectDir, run } = setup();
  writeFileSync(join(projectDir, '.gitignore'), 'node_modules/');
  run();
  assert.equal(readFileSync(join(projectDir, '.gitignore'), 'utf8'), `node_modules/\n${GITIGNORE_ENTRY}\n${REVIEWS_IGNORE_ENTRY}\n`);
});

test('mise à jour du template : un fichier non modifié localement est mis à jour', () => {
  const { templateDir, projectDir, run } = setup();
  run();
  writeFile(join(templateDir, 'agents/cc-planner.md'), readFileSync(join(templateDir, 'agents/cc-planner.md'), 'utf8') + '\nNouvelle consigne.\n');
  const actions = run();
  assert.deepEqual(byAction(actions, 'update'), ['agents/cc-planner.md']);
  assert.match(readFileSync(join(projectDir, '.claude/agents/cc-planner.md'), 'utf8'), /Nouvelle consigne/);
});

test('modification locale : jamais écrasée, reste en conflit, --force la remplace', () => {
  const { templateDir, projectDir, run } = setup();
  run();
  const local = join(projectDir, '.claude/agents/cc-planner.md');
  writeFileSync(local, readFileSync(local, 'utf8') + '\nAjout local.\n');
  writeFile(join(templateDir, 'agents/cc-planner.md'), readFileSync(join(templateDir, 'agents/cc-planner.md'), 'utf8') + '\nNouvelle consigne.\n');

  assert.deepEqual(byAction(run(), 'conflict'), ['agents/cc-planner.md']);
  assert.match(readFileSync(local, 'utf8'), /Ajout local/);
  // Toujours signalé à l'exécution suivante : le manifeste garde l'ancienne empreinte.
  assert.deepEqual(byAction(run(), 'conflict'), ['agents/cc-planner.md']);

  assert.deepEqual(byAction(run({ force: true }), 'overwrite'), ['agents/cc-planner.md']);
  assert.doesNotMatch(readFileSync(local, 'utf8'), /Ajout local/);
  assert.deepEqual(byAction(run(), 'conflict'), []);
});

test('fichier du projet portant le même nom qu\'un fichier du template : conflit', () => {
  const { projectDir, run } = setup();
  writeFile(join(projectDir, '.claude/agents/cc-code-reviewer.md'), '---\nname: cc-code-reviewer\n---\nAgent du projet\n');
  assert.deepEqual(byAction(run(), 'conflict'), ['agents/cc-code-reviewer.md']);
  assert.match(readFileSync(join(projectDir, '.claude/agents/cc-code-reviewer.md'), 'utf8'), /Agent du projet/);
});

test('team.json appartient au projet : jamais remplacé, même avec --force', () => {
  const { projectDir, run } = setup();
  run();
  const path = join(projectDir, '.claude/team.json');
  writeFileSync(path, '{"initialized": true, "projet": "réglé"}');
  assert.ok(byAction(run({ force: true }), 'keep').includes('team.json'));
  assert.match(readFileSync(path, 'utf8'), /réglé/);
});

test('skills de conventions : créées une fois, appartiennent au projet, jamais remplacées même avec --force', () => {
  const { templateDir, projectDir, run } = setup();
  const owned = ['skills/conventions-backend/SKILL.md', 'skills/conventions-frontend/SKILL.md'];
  const first = run();
  for (const rel of owned) assert.ok(byAction(first, 'add').includes(rel), rel);
  const manifest = JSON.parse(readFileSync(join(projectDir, '.claude', MANIFEST), 'utf8'));
  for (const rel of owned) assert.ok(!(rel in manifest.files), `${rel} ne doit pas être dans le manifeste`);

  const local = join(projectDir, '.claude', owned[0]);
  writeFileSync(local, '---\nname: conventions-backend\ndescription: Conventions du projet\nuser-invocable: false\n---\nExpress, tests Jest.\n');
  writeFile(join(templateDir, owned[0]), `${readFileSync(join(templateDir, owned[0]), 'utf8')}\nNouveau défaut.\n`);
  const again = run({ force: true });
  assert.deepEqual(byAction(again, 'keep').sort(), [...owned, 'team.json'].sort());
  assert.match(readFileSync(local, 'utf8'), /Express/);

  // Retirées du template : jamais supprimées du projet.
  rmSync(join(templateDir, 'skills/conventions-backend'), { recursive: true });
  run();
  assert.ok(existsSync(local));
  assert.deepEqual(validate(projectDir).errors, []);
});

test('fichier retiré du template : supprimé s\'il est intact, conservé s\'il est modifié', () => {
  const { templateDir, projectDir, run } = setup();
  run();
  writeFileSync(join(projectDir, '.claude/skills/which-surface/SKILL.md'), 'modifié localement');
  rmSync(join(templateDir, 'skills/which-surface'), { recursive: true });
  rmSync(join(templateDir, 'skills/team/templates/pr.md'));
  const actions = run();
  assert.deepEqual(byAction(actions, 'remove'), ['skills/team/templates/pr.md']);
  assert.deepEqual(byAction(actions, 'keep-modified'), ['skills/which-surface/SKILL.md']);
  assert.ok(!existsSync(join(projectDir, '.claude/skills/team/templates/pr.md')));
  assert.ok(existsSync(join(projectDir, '.claude/skills/which-surface/SKILL.md')));
});

test('fins de ligne CRLF : un fichier intact n\'est pas pris pour une modification', () => {
  const { projectDir, run } = setup();
  run();
  const path = join(projectDir, '.claude/agents/cc-planner.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'));
  assert.deepEqual(byAction(run(), 'conflict'), []);
});

test('--dry-run n\'écrit rien', () => {
  const { projectDir, run } = setup();
  const actions = run({ dryRun: true });
  assert.ok(byAction(actions, 'add').length > 0);
  assert.ok(!existsSync(join(projectDir, '.claude')));
  assert.ok(!existsSync(join(projectDir, '.gitignore')));
});

test('manifeste : un chemin hors de .claude/ n\'est jamais supprimé', () => {
  const { projectDir, run } = setup();
  run();
  const precious = join(projectDir, 'precious.txt');
  writeFileSync(precious, 'hello');
  const manifestPath = join(projectDir, '.claude', MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files['../precious.txt'] = hashOf(Buffer.from('hello'));
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const actions = run();
  assert.deepEqual(byAction(actions, 'unsafe-path'), ['../precious.txt']);
  assert.equal(readFileSync(precious, 'utf8'), 'hello');
});

test('manifeste invalide : erreur explicite, rien n\'est modifié', () => {
  const { projectDir, run } = setup();
  run();
  const manifestPath = join(projectDir, '.claude', MANIFEST);
  for (const content of ['{ cassé', '"abc"', '{"files": []}', '{"files": {"a.md": 1}}']) {
    writeFileSync(manifestPath, content);
    assert.throws(() => run(), /manifeste illisible ou invalide/);
  }
});

test('fichier supprimé dans le projet : non recréé, --force le restaure', () => {
  const { projectDir, run } = setup();
  run();
  const path = join(projectDir, '.claude/agents/cc-code-reviewer.md');
  rmSync(path);
  assert.deepEqual(byAction(run(), 'deleted-locally'), ['agents/cc-code-reviewer.md']);
  assert.ok(!existsSync(path));
  // Toujours respecté à l'exécution suivante.
  assert.deepEqual(byAction(run(), 'deleted-locally'), ['agents/cc-code-reviewer.md']);
  assert.deepEqual(byAction(run({ force: true }), 'restore'), ['agents/cc-code-reviewer.md']);
  assert.ok(existsSync(path));
});

test('variantes déjà présentes dans .gitignore : pas de doublon', () => {
  for (const variant of ['/.agent-runs/', '.agent-runs', '.agent-runs/*']) {
    const { projectDir, run } = setup();
    writeFileSync(join(projectDir, '.gitignore'), `${variant}\n`);
    assert.deepEqual(byAction(run(), 'gitignore'), [], variant);
  }
});

test('revues de PR : .agent-reviews/ ignoré par Git comme .agent-runs/, sans doublon ni variante répétée', () => {
  assert.equal(REVIEWS_IGNORE_ENTRY, '.agent-reviews/');
  for (const variant of ['/.agent-reviews/', '.agent-reviews', '.agent-reviews/*', '.agent-reviews/**']) {
    const { projectDir, run } = setup();
    writeFileSync(join(projectDir, '.gitignore'), `${variant}\n`);
    const actions = run();
    assert.deepEqual(byAction(actions, 'gitignore-reviews'), [], variant);
    assert.deepEqual(byAction(actions, 'gitignore'), ['../.gitignore'], variant);
    assert.doesNotMatch(readFileSync(join(projectDir, '.gitignore'), 'utf8'), /^\.agent-reviews\/$/m, variant);
  }
  // .agent-runs/ déjà ignoré (installation antérieure) : seule l'entrée des revues est ajoutée.
  const { projectDir, run } = setup();
  writeFileSync(join(projectDir, '.gitignore'), `node_modules/\n${GITIGNORE_ENTRY}\n`);
  const actions = run();
  assert.deepEqual(byAction(actions, 'gitignore'), []);
  assert.deepEqual(byAction(actions, 'gitignore-reviews'), ['../.gitignore']);
  assert.equal(readFileSync(join(projectDir, '.gitignore'), 'utf8'), `node_modules/\n${GITIGNORE_ENTRY}\n${REVIEWS_IGNORE_ENTRY}\n`);
  const dry = setup();
  assert.deepEqual(byAction(dry.run({ dryRun: true }), 'gitignore-reviews'), ['../.gitignore']);
  assert.ok(!existsSync(join(dry.projectDir, '.gitignore')));
});

test('module de revue de PR : agents, skill, scripts et page installés et suivis par le manifeste', () => {
  const { projectDir, run } = setup();
  const added = byAction(run(), 'add');
  const expected = [
    'agents/cc-pr-reviewer-frontend.md', 'agents/cc-pr-reviewer-backend.md', 'agents/cc-pr-reviewer-architecture.md', 'agents/cc-pr-verifier.md',
    'skills/team-review/SKILL.md', 'skills/team-review/workflow.md', 'skills/team-review/report/index.html',
    ...['store', 'source', 'pr-list', 'pr-fetch', 'findings', 'decisions', 'serve', 'publish', 'stats', 'review-batch'].map((n) => `skills/team-review/scripts/${n}.mjs`),
  ];
  const manifest = JSON.parse(readFileSync(join(projectDir, '.claude', MANIFEST), 'utf8'));
  for (const rel of expected) {
    assert.ok(added.includes(rel), rel);
    assert.ok(existsSync(join(projectDir, '.claude', rel)), rel);
    assert.ok(rel in manifest.files, `${rel} suivi par le manifeste`);
  }
  const settings = JSON.parse(readFileSync(join(projectDir, '.claude/settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('Bash(node .claude/skills/team-review/scripts/pr-fetch.mjs *)'));
  assert.ok(manifest.settingsAllow.includes('Bash(node .claude/skills/team-review/scripts/pr-fetch.mjs *)'));
  assert.ok(!settings.permissions.allow.some((a) => a.includes('publish.mjs')));
  assert.deepEqual(validate(projectDir).errors, []);
  // Les scripts installés se chargent depuis le projet (imports relatifs entre skills).
  const res = spawnSync(process.execPath, [join(projectDir, '.claude/skills/team-review/scripts/stats.mjs')], { encoding: 'utf8', cwd: projectDir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Aucune revue/);
});

test('le template ne peut pas être sa propre cible, quelle que soit la casse sous Windows', () => {
  const { templateDir } = setup();
  const root = join(templateDir, '..');
  assert.throws(() => install({ templateDir, projectDir: root, version: 'test' }), /template lui-même/);
  if (process.platform === 'win32') {
    assert.throws(() => install({ templateDir, projectDir: root.toUpperCase(), version: 'test' }), /template lui-même/);
  }
});

test('un manifeste présent dans le template n\'est jamais distribué', () => {
  const { templateDir, run } = setup();
  writeFileSync(join(templateDir, MANIFEST), '{"files": {}}');
  assert.ok(!run().some((a) => a.file === MANIFEST));
});

test('ligne de commande : 0 si appliqué, 2 en cas de conflit, 1 sans projet', () => {
  const projectDir = tempDir('projet-cli-');
  const cli = (...args) => spawnSync(process.execPath, [join(REPO_DIR, 'install.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(cli(projectDir, '--dry-run').status, 0);
  assert.ok(!existsSync(join(projectDir, '.claude')));
  writeFile(join(projectDir, '.claude/agents/cc-planner.md'), '---\nname: cc-planner\n---\nAgent du projet\n');
  const conflict = cli(projectDir);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stdout, /CONFLIT/);
  assert.equal(cli().status, 1);
  assert.equal(cli(join(projectDir, 'absent')).status, 1);
});

test('projet inexistant : erreur', () => {
  const { templateDir } = setup();
  assert.throws(() => install({ templateDir, projectDir: join(tempDir(), 'absent'), version: 'test' }), /introuvable/);
});

// --- Mise à jour d'un projet installé avant 0.10 (agents sans préfixe cc-) ---

/** Template tel qu'installé avant 0.10 : fichiers d'agents et clés de team.json sans préfixe. */
function legacyTemplate() {
  const templateDir = join(tempDir('legacy-'), '.claude');
  cpSync(TEMPLATE_CLAUDE, templateDir, { recursive: true });
  for (const [old, current] of Object.entries(LEGACY_AGENTS)) {
    const text = readFileSync(join(templateDir, 'agents', `${current}.md`), 'utf8').replace(`name: ${current}`, `name: ${old}`);
    writeFileSync(join(templateDir, 'agents', `${old}.md`), text);
    rmSync(join(templateDir, 'agents', `${current}.md`));
  }
  const teamPath = join(templateDir, 'team.json');
  const team = JSON.parse(readFileSync(teamPath, 'utf8'));
  team.agents = Object.fromEntries(Object.entries(team.agents).map(([k, v]) => [k.replace(/^cc-/, ''), v]));
  writeFileSync(teamPath, `${JSON.stringify(team, null, 2)}\n`);
  return templateDir;
}

test('mise à jour depuis 0.9 : anciens agents retirés sauf modifiés, nouveaux ajoutés, clés agents de team.json migrées', () => {
  const projectDir = tempDir('projet-');
  install({ templateDir: legacyTemplate(), projectDir, version: '0.9.0' });
  const teamPath = join(projectDir, '.claude/team.json');
  const before = JSON.parse(readFileSync(teamPath, 'utf8'));
  before.initialized = true;
  before.agents['implementer-frontend'] = false;
  writeFileSync(teamPath, `${JSON.stringify(before, null, 2)}\n`);
  const expertPath = join(projectDir, '.claude/agents/expert.md');
  writeFileSync(expertPath, `${readFileSync(expertPath, 'utf8')}\nAjout local.\n`);

  const dry = install({ templateDir: TEMPLATE_CLAUDE, projectDir, version: '0.10.0', dryRun: true });
  assert.deepEqual(byAction(dry, 'migrate'), ['team.json']);
  assert.deepEqual(JSON.parse(readFileSync(teamPath, 'utf8')), before, 'dry-run : team.json intact');
  assert.ok(existsSync(join(projectDir, '.claude/agents/planner.md')), 'dry-run : rien supprimé');

  const actions = install({ templateDir: TEMPLATE_CLAUDE, projectDir, version: '0.10.0' });
  const oldNames = Object.keys(LEGACY_AGENTS);
  assert.deepEqual(byAction(actions, 'remove').sort(), oldNames.filter((n) => n !== 'expert').map((n) => `agents/${n}.md`).sort());
  assert.deepEqual(byAction(actions, 'keep-modified'), ['agents/expert.md']);
  for (const current of Object.values(LEGACY_AGENTS)) assert.ok(byAction(actions, 'add').includes(`agents/${current}.md`), current);
  assert.ok(!existsSync(join(projectDir, '.claude/agents/planner.md')));
  assert.match(readFileSync(expertPath, 'utf8'), /Ajout local/);

  assert.deepEqual(byAction(actions, 'migrate'), ['team.json']);
  const after = JSON.parse(readFileSync(teamPath, 'utf8'));
  assert.equal(after.initialized, true);
  assert.deepEqual(Object.keys(after.agents), Object.keys(before.agents).map((k) => `cc-${k}`));
  assert.equal(after.agents['cc-implementer-frontend'], false);
  assert.equal(after.agents['cc-implementer'], true);
  assert.deepEqual(validate(projectDir).errors, []);

  // Rien à migrer au passage suivant : team.json est seulement conservé.
  const again = install({ templateDir: TEMPLATE_CLAUDE, projectDir, version: '0.10.0' });
  assert.deepEqual(byAction(again, 'migrate'), []);
  assert.ok(byAction(again, 'keep').includes('team.json'));
});

test('migrateTeamAgents : clés renommées à leur place, valeur gardée, une clé déjà migrée l\'emporte', () => {
  const config = { initialized: true, agents: { planner: true, implementer: false, 'cc-implementer': true, 'cc-expert': false, autre: true }, checks: [] };
  const migrated = migrateTeamAgents(config);
  assert.deepEqual(Object.keys(migrated), ['initialized', 'agents', 'checks']);
  assert.deepEqual(migrated.agents, { 'cc-planner': true, 'cc-implementer': true, 'cc-expert': false, autre: true });
  assert.equal(migrateTeamAgents({ agents: { 'cc-planner': true } }), null);
  assert.equal(migrateTeamAgents({ agents: 'oui' }), null);
  assert.equal(migrateTeamAgents({}), null);
});

// --- settings.json : fusionné, jamais remplacé ---

const readSettings = (projectDir) => JSON.parse(readFileSync(join(projectDir, '.claude/settings.json'), 'utf8'));
const ourCommands = (settings) => Object.values(settings.hooks ?? {}).flat()
  .flatMap((g) => g.hooks).map((h) => h.command).filter((c) => c.includes('.claude/hooks/team/'));
// Nombre de hooks de l'équipe déclarés par le template (il change d'une version à l'autre).
const TEAM_HOOKS = ourCommands(JSON.parse(readFileSync(join(TEMPLATE_CLAUDE, 'settings.json'), 'utf8'))).length;

test('settings.json absent : créé avec les hooks de l\'équipe', () => {
  const { projectDir, run } = setup();
  assert.deepEqual(byAction(run(), 'add').filter((f) => f === 'settings.json'), ['settings.json']);
  assert.equal(ourCommands(readSettings(projectDir)).length, TEAM_HOOKS);
  assert.deepEqual(validate(projectDir).errors, []);
});

test('settings.json du projet : réglages conservés, hooks de l\'équipe ajoutés une seule fois', () => {
  const { projectDir, run } = setup();
  const own = {
    model: 'opus',
    permissions: { allow: ['Bash(make test)'], deny: ['Bash(curl *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/own-hook.mjs' }] }] },
  };
  writeFile(join(projectDir, '.claude/settings.json'), JSON.stringify(own));
  assert.deepEqual(byAction(run(), 'merge'), ['settings.json']);
  const merged = readSettings(projectDir);
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.permissions.deny, ['Bash(curl *)']);
  assert.ok(merged.permissions.allow.includes('Bash(make test)'));
  assert.ok(merged.permissions.allow.some((a) => a.includes('run-checks.mjs')));
  assert.ok(merged.hooks.PreToolUse.some((g) => g.hooks[0].command === 'node scripts/own-hook.mjs'));
  assert.equal(ourCommands(merged).length, TEAM_HOOKS);

  assert.deepEqual(byAction(run(), 'unchanged').filter((f) => f === 'settings.json'), ['settings.json']);
  assert.equal(ourCommands(readSettings(projectDir)).length, TEAM_HOOKS);
});

test('settings.json : un hook ou une permission retirés du template disparaissent, ceux du projet restent', () => {
  const { templateDir, projectDir, run } = setup();
  run();
  const settings = readSettings(projectDir);
  settings.permissions.allow.push('Bash(make test)');
  writeFileSync(join(projectDir, '.claude/settings.json'), JSON.stringify(settings));

  const template = JSON.parse(readFileSync(join(templateDir, 'settings.json'), 'utf8'));
  const stopHooks = ourCommands({ hooks: { Stop: template.hooks.Stop } }).length;
  delete template.hooks.Stop;
  template.permissions.allow = template.permissions.allow.filter((a) => !a.includes('check-state'));
  writeFileSync(join(templateDir, 'settings.json'), JSON.stringify(template));

  assert.deepEqual(byAction(run(), 'merge'), ['settings.json']);
  const after = readSettings(projectDir);
  assert.equal(after.hooks.Stop, undefined);
  assert.equal(ourCommands(after).length, TEAM_HOOKS - stopHooks);
  assert.ok(after.permissions.allow.includes('Bash(make test)'));
  assert.ok(!after.permissions.allow.some((a) => a.includes('check-state')));
});

test('settings.json illisible : conflit, fichier intact, code 2', () => {
  const { projectDir, run } = setup();
  writeFile(join(projectDir, '.claude/settings.json'), '{ "hooks": ');
  assert.deepEqual(byAction(run(), 'conflict'), ['settings.json']);
  assert.equal(readFileSync(join(projectDir, '.claude/settings.json'), 'utf8'), '{ "hooks": ');
});

test('mergeSettings : fonction pure, ne modifie pas ses entrées', () => {
  const project = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/team/ancien.mjs"' }] }] } };
  const template = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/team/keep-running.mjs"' }] }] } };
  const frozen = JSON.stringify(project);
  const merged = mergeSettings(project, template, []);
  assert.equal(JSON.stringify(project), frozen);
  assert.deepEqual(ourCommands(merged), ['node "$CLAUDE_PROJECT_DIR/.claude/hooks/team/keep-running.mjs"']);
});

// --- .claude/ dans le .gitignore du projet : sur demande, sans rien effacer ---

const gitignoreOf = (projectDir) => readFileSync(join(projectDir, '.gitignore'), 'utf8');

test('ignoreClaude : .claude/ ajouté à la fin du .gitignore, contenu existant conservé, sans doublon', () => {
  const { projectDir, run } = setup();
  writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\ndist/');
  const actions = run({ ignoreClaude: true });
  assert.deepEqual(byAction(actions, 'gitignore-claude'), ['../.gitignore']);
  assert.equal(gitignoreOf(projectDir), `node_modules/\ndist/\n${GITIGNORE_ENTRY}\n${REVIEWS_IGNORE_ENTRY}\n${CLAUDE_IGNORE_ENTRY}\n`);
  run({ ignoreClaude: true });
  assert.equal(gitignoreOf(projectDir).split('\n').filter((l) => l === CLAUDE_IGNORE_ENTRY).length, 1);
});

test('ignoreClaude : une variante déjà présente (.claude, /.claude/, .claude/*) n\'est pas dupliquée', () => {
  for (const variant of ['.claude', '/.claude/', '.claude/*']) {
    const { projectDir, run } = setup();
    writeFileSync(join(projectDir, '.gitignore'), `${variant}\n`);
    const actions = run({ ignoreClaude: true });
    assert.deepEqual(byAction(actions, 'gitignore-claude'), [], variant);
    assert.deepEqual(byAction(actions, 'gitignore-claude-present'), ['../.gitignore'], variant);
    assert.doesNotMatch(gitignoreOf(projectDir), new RegExp(`^${CLAUDE_IGNORE_ENTRY.replace('.', '\.')}$`, 'm'), variant);
  }
});

test('sans ignoreClaude (défaut) : .claude/ n\'est jamais ajouté', () => {
  const { projectDir, run } = setup();
  run();
  assert.doesNotMatch(gitignoreOf(projectDir), /^\/?\.claude/m);
});

test('ligne de commande : --ignore-claude ajoute, --no-ignore-claude non, sans terminal la question n\'est pas posée', () => {
  const cli = (...args) => spawnSync(process.execPath, [join(REPO_DIR, 'install.mjs'), ...args], { encoding: 'utf8', input: '' });
  const yes = tempDir('projet-oui-');
  assert.equal(cli(yes, '--ignore-claude').status, 0);
  assert.match(gitignoreOf(yes), /^\.claude\/$/m);
  const no = tempDir('projet-non-');
  assert.equal(cli(no, '--no-ignore-claude').status, 0);
  assert.doesNotMatch(gitignoreOf(no), /^\.claude\/$/m);
  const silent = tempDir('projet-sans-');
  const out = cli(silent);
  assert.equal(out.status, 0);
  assert.doesNotMatch(gitignoreOf(silent), /^\.claude\/$/m);
  assert.match(out.stdout, /--ignore-claude/);
});

test('question interactive : « o » ajoute .claude/, une autre réponse non, déjà ignoré → pas de question', async () => {
  const silentLog = { log: () => {}, warn: () => {}, error: () => {} };
  const asked = [];
  const oui = tempDir('projet-q-oui-');
  await installMain(['node', 'install.mjs', oui], { interactive: true, ask: async (q) => { asked.push(q); return 'o'; }, ...silentLog });
  assert.match(gitignoreOf(oui), /^\.claude\/$/m);
  assert.match(asked[0], /\.gitignore/);

  const non = tempDir('projet-q-non-');
  await installMain(['node', 'install.mjs', non], { interactive: true, ask: async () => '', ...silentLog });
  assert.doesNotMatch(gitignoreOf(non), /^\.claude\/$/m);

  const deja = tempDir('projet-q-deja-');
  writeFileSync(join(deja, '.gitignore'), '.claude\n');
  let questions = 0;
  await installMain(['node', 'install.mjs', deja], { interactive: true, ask: async () => { questions += 1; return 'o'; }, ...silentLog });
  assert.equal(questions, 0);
});

// --- --local : exclusion locale Git (.git/info/exclude), rien dans .gitignore ---

const git = (cwd, ...args) => {
  const res = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')} : ${res.stderr}`);
  return res.stdout;
};

/** Dépôt Git réel, vide (git init). */
function gitRepo(prefix = 'projet-git-') {
  const dir = tempDir(prefix);
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** Exécuteur git simulé : rev-parse et ls-files seulement, comme dans les tests de gh.mjs. */
function fakeGit({ toplevel = 'C:/projet', prefix = '', exclude = '.git/info/exclude', tracked = [], fail = false } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'git') return { code: 127, stdout: '', stderr: `${cmd} introuvable` };
    if (fail) return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${toplevel}\n${prefix}\n${exclude}\n`, stderr: '' };
    if (args[0] === 'ls-files') {
      const wanted = args.slice(args.indexOf('--') + 1);
      return { code: 0, stdout: wanted.filter((p) => tracked.includes(p)).map((p) => `${p}\0`).join(''), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `commande inattendue : git ${args.join(' ')}` };
  };
  return { exec, calls };
}

const blockOf = (text) => {
  const lines = text.split(/\r?\n/);
  const begin = lines.indexOf(EXCLUDE_BEGIN);
  const end = lines.indexOf(EXCLUDE_END);
  assert.ok(begin >= 0 && end > begin, 'bloc présent');
  return lines.slice(begin + 1, end);
};

test('--local dans un vrai dépôt : git status vide après installation, fichiers suivis du projet intacts et visibles', () => {
  const { templateDir, run } = setup();
  const projectDir = gitRepo();
  writeFile(join(projectDir, 'README.md'), 'projet\n');
  writeFile(join(projectDir, '.claude/commands/own.md'), 'commande du projet\n');
  // Un fichier du template déjà suivi par Git, à l'identique : l'exclusion ne peut pas le cacher.
  writeFile(join(projectDir, '.claude/agents/cc-planner.md'), readFileSync(join(templateDir, 'agents/cc-planner.md')));
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-q', '-m', 'init');

  const actions = run({ projectDir, local: true });
  assert.ok(byAction(actions, 'add').includes('agents/cc-code-reviewer.md'));
  assert.deepEqual(byAction(actions, 'tracked'), ['.claude/agents/cc-planner.md']);
  assert.equal(git(projectDir, 'status', '--porcelain'), '');
  assert.ok(existsSync(join(projectDir, '.claude', MANIFEST)));
  assert.ok(existsSync(join(projectDir, '.claude/settings.local.json')));
  assert.ok(!existsSync(join(projectDir, '.gitignore')));
  assert.equal(git(projectDir, 'ls-files', '.claude/commands/own.md').trim(), '.claude/commands/own.md');
  assert.equal(git(projectDir, 'ls-files', '.claude/agents/cc-planner.md').trim(), '.claude/agents/cc-planner.md');

  const exclude = readFileSync(join(projectDir, '.git/info/exclude'), 'utf8');
  const block = blockOf(exclude);
  assert.ok(block.includes('/.claude/agents/cc-code-reviewer.md'));
  assert.ok(block.includes('/.claude/team.json'));
  assert.ok(block.includes('/.claude/settings.local.json'));
  assert.ok(block.includes(`/.claude/${MANIFEST}`));
  assert.ok(block.includes('/.agent-runs/') && block.includes('/.agent-reviews/'));
  assert.ok(!block.includes('/.claude/') && !block.includes('/.claude'), 'jamais .claude/ en entier');
  assert.ok(!block.includes('/.claude/commands/own.md'), 'jamais un fichier du projet');
  assert.ok(!block.includes('/.claude/settings.json'));
  assert.match(exclude, /^# Lines that start with/m, 'contenu Git d\'origine conservé');

  writeFileSync(join(projectDir, 'README.md'), 'modifié\n');
  assert.equal(git(projectDir, 'status', '--porcelain').trim(), 'M README.md');
  assert.deepEqual(validate(projectDir).errors, []);

  // Worktree : .git est un fichier, l'exclusion est celle du dépôt principal.
  const wt = join(tempDir('wt-'), 'wt');
  git(projectDir, 'worktree', 'add', '-q', wt, '-b', 'wt');
  const expected = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: wt, encoding: 'utf8' }).stdout.trim();
  const wtActions = run({ projectDir: wt, local: true });
  const [excludeAction] = wtActions.filter((a) => a.action === 'exclude');
  assert.equal(resolve(excludeAction.file).toLowerCase(), resolve(wt, expected).toLowerCase());
  assert.equal(git(wt, 'status', '--porcelain'), '');
  git(projectDir, 'worktree', 'remove', '--force', wt);
});

test('--local : .gitignore du projet jamais modifié, ni créé', () => {
  const { projectDir, run } = setup();
  writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
  const actions = run({ local: true, exec: fakeGit().exec });
  assert.deepEqual(actions.filter((a) => a.file === '../.gitignore'), []);
  assert.equal(gitignoreOf(projectDir), 'node_modules/\n');
  const bare = setup();
  bare.run({ local: true, exec: fakeGit().exec });
  assert.ok(!existsSync(join(bare.projectDir, '.gitignore')));
});

test('--local : bloc réécrit en entier à la mise à jour, reste du fichier d\'exclusion conservé', () => {
  const { templateDir, projectDir, run } = setup();
  const excludePath = join(projectDir, '.git/info/exclude');
  writeFile(excludePath, `notes/\n${EXCLUDE_BEGIN}\n/.claude/perime.md\n${EXCLUDE_END}\napres/`);
  const exec = fakeGit({ exclude: excludePath }).exec;
  run({ local: true, exec });
  let text = readFileSync(excludePath, 'utf8');
  assert.ok(text.startsWith('notes/\n'));
  assert.match(text, /^apres\/$/m);
  assert.ok(blockOf(text).includes('/.claude/skills/team/templates/pr.md'));
  assert.ok(!blockOf(text).includes('/.claude/perime.md'));
  assert.equal(text.split(EXCLUDE_BEGIN).length, 2, 'un seul bloc');

  rmSync(join(templateDir, 'skills/team/templates/pr.md'));
  assert.deepEqual(byAction(run({ local: true, exec }), 'remove'), ['skills/team/templates/pr.md']);
  text = readFileSync(excludePath, 'utf8');
  assert.ok(!blockOf(text).includes('/.claude/skills/team/templates/pr.md'));
  assert.ok(text.startsWith('notes/\n') && /^apres\/$/m.test(text));
  assert.equal(text.split(EXCLUDE_BEGIN).length, 2);

  // Fins de ligne CRLF conservées.
  const crlf = setup();
  const crlfPath = join(crlf.projectDir, '.git/info/exclude');
  writeFile(crlfPath, 'notes/\r\n');
  crlf.run({ local: true, exec: fakeGit({ exclude: crlfPath }).exec });
  const crlfText = readFileSync(crlfPath, 'utf8');
  assert.ok(crlfText.startsWith('notes/\r\n') && !/[^\r]\n/.test(crlfText));
});

test('--local : le fichier d\'exclusion est celui de git rev-parse --git-path (worktree), dossier info/ créé', () => {
  const { projectDir, run } = setup();
  const excludePath = join(tempDir('depot-principal-'), '.git/info/exclude');
  const { exec, calls } = fakeGit({ exclude: excludePath.replace(/\\/g, '/') });
  run({ local: true, exec });
  assert.ok(existsSync(excludePath));
  assert.ok(!existsSync(join(projectDir, '.git')));
  assert.ok(calls.some((c) => c[1] === 'rev-parse' && c.includes('--git-path') && c.includes('info/exclude')));
  assert.ok(calls.some((c) => c[1] === 'rev-parse' && c.includes('--show-toplevel')));
});

test('--local : projet dans un sous-dossier du dépôt → chemins ancrés depuis la racine Git', () => {
  const { run } = setup();
  const excludePath = join(tempDir('racine-'), '.git/info/exclude');
  run({ local: true, exec: fakeGit({ prefix: 'apps/web/', exclude: excludePath }).exec });
  const block = blockOf(readFileSync(excludePath, 'utf8'));
  assert.ok(block.includes('/apps/web/.claude/agents/cc-planner.md'));
  assert.ok(block.includes('/apps/web/.agent-runs/'));
  assert.ok(block.every((l) => l.startsWith('/apps/web/')));
  assert.ok(block.every((l) => !l.includes('\\')));
});

test('--local : réglages dans settings.local.json (mêmes règles de fusion), settings.json non créé', () => {
  const { projectDir, run } = setup();
  const own = { model: 'opus', permissions: { allow: ['Bash(make test)'] } };
  writeFile(join(projectDir, '.claude/settings.local.json'), JSON.stringify(own));
  const actions = run({ local: true, exec: fakeGit().exec });
  assert.deepEqual(byAction(actions, 'merge'), ['settings.local.json']);
  assert.ok(!existsSync(join(projectDir, '.claude/settings.json')));
  const merged = JSON.parse(readFileSync(join(projectDir, '.claude/settings.local.json'), 'utf8'));
  assert.equal(merged.model, 'opus');
  assert.ok(merged.permissions.allow.includes('Bash(make test)'));
  assert.equal(ourCommands(merged).length, TEAM_HOOKS);
  assert.deepEqual(byAction(run({ local: true, exec: fakeGit().exec }), 'unchanged').filter((f) => f.startsWith('settings')), ['settings.local.json']);

  // Un settings.json d'une installation non locale antérieure est signalé, jamais modifié.
  const shared = setup();
  shared.run();
  const before = readFileSync(join(shared.projectDir, '.claude/settings.json'), 'utf8');
  const again = shared.run({ local: true, exec: fakeGit().exec });
  assert.deepEqual(byAction(again, 'shared-settings'), ['settings.json']);
  assert.deepEqual(byAction(again, 'add'), ['settings.local.json']);
  assert.equal(readFileSync(join(shared.projectDir, '.claude/settings.json'), 'utf8'), before);
});

test('--local : mode mémorisé dans le manifeste, conservé sans option, changement de mode signalé', () => {
  const { projectDir, run } = setup();
  const excludePath = join(projectDir, '.git/info/exclude');
  const exec = fakeGit({ exclude: excludePath }).exec;
  const first = run({ local: true, exec });
  assert.deepEqual(byAction(first, 'mode-local'), [MANIFEST]);
  assert.equal(JSON.parse(readFileSync(join(projectDir, '.claude', MANIFEST), 'utf8')).mode, 'local');
  assert.equal(installedMode(projectDir), 'local');

  const update = run({ exec });
  assert.deepEqual(byAction(update, 'exclude'), [excludePath]);
  assert.deepEqual(byAction(update, 'mode-local'), []);
  assert.ok(!existsSync(join(projectDir, '.gitignore')));
  assert.ok(!existsSync(join(projectDir, '.claude/settings.json')));
  assert.equal(JSON.parse(readFileSync(join(projectDir, '.claude', MANIFEST), 'utf8')).mode, 'local');

  const shared = run({ local: false, exec });
  assert.deepEqual(byAction(shared, 'mode-shared'), [MANIFEST]);
  assert.deepEqual(byAction(shared, 'exclude-removed'), [excludePath]);
  assert.equal(JSON.parse(readFileSync(join(projectDir, '.claude', MANIFEST), 'utf8')).mode, 'shared');
  assert.ok(existsSync(join(projectDir, '.gitignore')));
  assert.doesNotMatch(readFileSync(excludePath, 'utf8'), /claude-config/);
});

test('--local avec --ignore-claude : refusé ; hors dépôt Git : refusé, rien n\'est écrit', () => {
  const { projectDir, run } = setup();
  assert.throws(() => run({ local: true, ignoreClaude: true, exec: fakeGit().exec }), /--ignore-claude/);
  assert.throws(() => run({ local: true, exec: fakeGit({ fail: true }).exec }), /dépôt Git/);
  assert.ok(!existsSync(join(projectDir, '.claude')));
  assert.ok(!existsSync(join(projectDir, '.gitignore')));

  const cli = (...args) => spawnSync(process.execPath, [join(REPO_DIR, 'install.mjs'), ...args], { encoding: 'utf8', input: '' });
  const repo = gitRepo();
  for (const flag of ['--ignore-claude', '--no-ignore-claude']) {
    const res = cli(repo, '--local', flag);
    assert.equal(res.status, 1, flag);
    assert.match(res.stderr, /--local/);
    assert.ok(!existsSync(join(repo, '.claude')));
  }
  const noGit = tempDir('projet-sans-git-');
  const res = cli(noGit, '--local');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /dépôt Git/);
  assert.ok(!existsSync(join(noGit, '.claude')));
});

test('--dry-run --local : affiche le bloc et le fichier d\'exclusion, n\'écrit rien', () => {
  const repo = gitRepo();
  const cli = (...args) => spawnSync(process.execPath, [join(REPO_DIR, 'install.mjs'), ...args], { encoding: 'utf8', input: '' });
  const res = cli(repo, '--local', '--dry-run');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[simulation\]/);
  assert.ok(res.stdout.includes(EXCLUDE_BEGIN) && res.stdout.includes(EXCLUDE_END));
  assert.match(res.stdout, /^\/\.claude\/agents\/cc-planner\.md$/m);
  assert.match(res.stdout, /info[\\/]exclude/);
  assert.ok(!existsSync(join(repo, '.claude')));
  assert.ok(!existsSync(join(repo, '.gitignore')));
  const excludePath = join(repo, '.git/info/exclude');
  assert.ok(!existsSync(excludePath) || !readFileSync(excludePath, 'utf8').includes(EXCLUDE_BEGIN));
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
