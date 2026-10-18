import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { GITIGNORE_ENTRY, hashOf, install, MANIFEST, mergeSettings } from '../install.mjs';
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
  assert.ok(byAction(actions, 'add').includes('agents/planner.md'));
  assert.ok(byAction(actions, 'add').includes('team.json'));
  assert.deepEqual(byAction(actions, 'gitignore'), ['../.gitignore']);
  assert.ok(existsSync(join(projectDir, '.claude', MANIFEST)));
  assert.match(readFileSync(join(projectDir, '.gitignore'), 'utf8'), new RegExp(`^${GITIGNORE_ENTRY}$`, 'm'));
  assert.deepEqual(validate(projectDir).errors, []);
});

test('réinstallation sans changement : rien ne bouge, .gitignore non dupliqué', () => {
  const { projectDir, run } = setup();
  run();
  const actions = run();
  assert.deepEqual(new Set(actions.map((a) => a.action)), new Set(['unchanged', 'keep']));
  const count = readFileSync(join(projectDir, '.gitignore'), 'utf8').split('\n').filter((l) => l === GITIGNORE_ENTRY).length;
  assert.equal(count, 1);
});

test('.gitignore existant sans saut de ligne final : entrée ajoutée sur sa propre ligne', () => {
  const { projectDir, run } = setup();
  writeFileSync(join(projectDir, '.gitignore'), 'node_modules/');
  run();
  assert.equal(readFileSync(join(projectDir, '.gitignore'), 'utf8'), `node_modules/\n${GITIGNORE_ENTRY}\n`);
});

test('mise à jour du template : un fichier non modifié localement est mis à jour', () => {
  const { templateDir, projectDir, run } = setup();
  run();
  writeFile(join(templateDir, 'agents/planner.md'), readFileSync(join(templateDir, 'agents/planner.md'), 'utf8') + '\nNouvelle consigne.\n');
  const actions = run();
  assert.deepEqual(byAction(actions, 'update'), ['agents/planner.md']);
  assert.match(readFileSync(join(projectDir, '.claude/agents/planner.md'), 'utf8'), /Nouvelle consigne/);
});

test('modification locale : jamais écrasée, reste en conflit, --force la remplace', () => {
  const { templateDir, projectDir, run } = setup();
  run();
  const local = join(projectDir, '.claude/agents/planner.md');
  writeFileSync(local, readFileSync(local, 'utf8') + '\nAjout local.\n');
  writeFile(join(templateDir, 'agents/planner.md'), readFileSync(join(templateDir, 'agents/planner.md'), 'utf8') + '\nNouvelle consigne.\n');

  assert.deepEqual(byAction(run(), 'conflict'), ['agents/planner.md']);
  assert.match(readFileSync(local, 'utf8'), /Ajout local/);
  // Toujours signalé à l'exécution suivante : le manifeste garde l'ancienne empreinte.
  assert.deepEqual(byAction(run(), 'conflict'), ['agents/planner.md']);

  assert.deepEqual(byAction(run({ force: true }), 'overwrite'), ['agents/planner.md']);
  assert.doesNotMatch(readFileSync(local, 'utf8'), /Ajout local/);
  assert.deepEqual(byAction(run(), 'conflict'), []);
});

test('fichier du projet portant le même nom qu\'un fichier du template : conflit', () => {
  const { projectDir, run } = setup();
  writeFile(join(projectDir, '.claude/agents/code-reviewer.md'), '---\nname: code-reviewer\n---\nAgent du projet\n');
  assert.deepEqual(byAction(run(), 'conflict'), ['agents/code-reviewer.md']);
  assert.match(readFileSync(join(projectDir, '.claude/agents/code-reviewer.md'), 'utf8'), /Agent du projet/);
});

test('team.json appartient au projet : jamais remplacé, même avec --force', () => {
  const { projectDir, run } = setup();
  run();
  const path = join(projectDir, '.claude/team.json');
  writeFileSync(path, '{"initialized": true, "projet": "réglé"}');
  assert.deepEqual(byAction(run({ force: true }), 'keep'), ['team.json']);
  assert.match(readFileSync(path, 'utf8'), /réglé/);
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
  const path = join(projectDir, '.claude/agents/planner.md');
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
  const path = join(projectDir, '.claude/agents/code-reviewer.md');
  rmSync(path);
  assert.deepEqual(byAction(run(), 'deleted-locally'), ['agents/code-reviewer.md']);
  assert.ok(!existsSync(path));
  // Toujours respecté à l'exécution suivante.
  assert.deepEqual(byAction(run(), 'deleted-locally'), ['agents/code-reviewer.md']);
  assert.deepEqual(byAction(run({ force: true }), 'restore'), ['agents/code-reviewer.md']);
  assert.ok(existsSync(path));
});

test('variantes déjà présentes dans .gitignore : pas de doublon', () => {
  for (const variant of ['/.agent-runs/', '.agent-runs', '.agent-runs/*']) {
    const { projectDir, run } = setup();
    writeFileSync(join(projectDir, '.gitignore'), `${variant}\n`);
    assert.deepEqual(byAction(run(), 'gitignore'), [], variant);
  }
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
  writeFile(join(projectDir, '.claude/agents/planner.md'), '---\nname: planner\n---\nAgent du projet\n');
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

// --- settings.json : fusionné, jamais remplacé ---

const readSettings = (projectDir) => JSON.parse(readFileSync(join(projectDir, '.claude/settings.json'), 'utf8'));
const ourCommands = (settings) => Object.values(settings.hooks ?? {}).flat()
  .flatMap((g) => g.hooks).map((h) => h.command).filter((c) => c.includes('.claude/hooks/team/'));

test('settings.json absent : créé avec les hooks de l\'équipe', () => {
  const { projectDir, run } = setup();
  assert.deepEqual(byAction(run(), 'add').filter((f) => f === 'settings.json'), ['settings.json']);
  assert.equal(ourCommands(readSettings(projectDir)).length, 4);
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
  assert.equal(ourCommands(merged).length, 4);

  assert.deepEqual(byAction(run(), 'unchanged').filter((f) => f === 'settings.json'), ['settings.json']);
  assert.equal(ourCommands(readSettings(projectDir)).length, 4);
});

test('settings.json : un hook ou une permission retirés du template disparaissent, ceux du projet restent', () => {
  const { templateDir, projectDir, run } = setup();
  run();
  const settings = readSettings(projectDir);
  settings.permissions.allow.push('Bash(make test)');
  writeFileSync(join(projectDir, '.claude/settings.json'), JSON.stringify(settings));

  const template = JSON.parse(readFileSync(join(templateDir, 'settings.json'), 'utf8'));
  delete template.hooks.Stop;
  template.permissions.allow = template.permissions.allow.filter((a) => !a.includes('check-state'));
  writeFileSync(join(templateDir, 'settings.json'), JSON.stringify(template));

  assert.deepEqual(byAction(run(), 'merge'), ['settings.json']);
  const after = readSettings(projectDir);
  assert.equal(after.hooks.Stop, undefined);
  assert.equal(ourCommands(after).length, 3);
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
