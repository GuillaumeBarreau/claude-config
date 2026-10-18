import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { sensitiveFiles } from '../template/.claude/skills/team/scripts/sensitive.mjs';
import { templateCopy } from './helpers.mjs';

const categoryOf = (path, extra) => sensitiveFiles([path], extra)[0]?.category ?? null;

test('sensitive : manifestes et lockfiles de dépendances, à toute profondeur', () => {
  for (const path of ['package.json', 'apps/web/package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock',
    'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock',
    'pom.xml', 'build.gradle', 'build.gradle.kts', 'src/App/App.csproj', 'packages.config', 'PACKAGE.JSON']) {
    assert.equal(categoryOf(path), 'dependencies', path);
  }
});

test('sensitive : migrations, CI, authentification, secrets, configuration de l\'équipe', () => {
  const expected = {
    'db/migrations/0001_init.sql': 'migrations',
    'app/migrate/20240101_users.rb': 'migrations',
    'alembic/versions/abc.py': 'migrations',
    'prisma/schema.prisma': 'migrations',
    'db/schema.rb': 'migrations',
    '.github/workflows/ci.yml': 'ci',
    '.github/actions/setup/action.yml': 'ci',
    '.gitlab-ci.yml': 'ci',
    '.circleci/config.yml': 'ci',
    'Jenkinsfile': 'ci',
    'azure-pipelines.yml': 'ci',
    '.pre-commit-config.yaml': 'ci',
    '.github/CODEOWNERS': 'ci',
    'src/auth/login.ts': 'auth',
    'src\\OAuth\\client.ts': 'auth',
    'lib/permissions/index.js': 'auth',
    'api/rbac/roles.py': 'auth',
    'core/security/csrf.py': 'auth',
    '.env': 'secrets',
    'config/.env.production': 'secrets',
    'certs/server.pem': 'secrets',
    'deploy/secrets/token.txt': 'secrets',
    'credentials.json': 'secrets',
    '.claude/settings.json': 'team-config',
    './.claude/team.json': 'team-config',
  };
  for (const [path, category] of Object.entries(expected)) assert.equal(categoryOf(path), category, path);
});

test('sensitive : pas de faux positif sur des noms proches', () => {
  for (const path of ['src/author.ts', 'src/authentication-notes.md', 'docs/package-json.md', '.env.example',
    'src/migration-guide.md', 'README.md', 'tests/test_auth_helpers.py', 'src/package.json.bak', 'src/permissions.ts']) {
    assert.equal(categoryOf(path), null, path);
  }
});

test('sensitive : sensitivePaths de team.json ajoute des motifs, n\'en retire jamais', () => {
  assert.equal(categoryOf('infra/main.tf'), null);
  assert.equal(categoryOf('infra/main.tf', ['infra/**']), 'custom');
  assert.equal(categoryOf('src/billing/stripe.ts', ['src/billing/*.ts']), 'custom');
  assert.equal(categoryOf('src/billing/sub/stripe.ts', ['src/billing/*.ts']), null);
  assert.equal(categoryOf('db/dump.sql', ['*.sql']), 'custom');
  assert.equal(categoryOf('a/b/v1.key2', ['**/v?.key2']), 'custom');
  // Un motif ajouté ne rend pas un fichier sensible « non sensible ».
  assert.equal(categoryOf('package.json', ['!package.json']), 'dependencies');
  assert.deepEqual(sensitiveFiles(['src/a.ts', 'package.json']), [{ path: 'package.json', category: 'dependencies' }]);
});

test('sensitive (CLI) : 1 si un chemin est sensible, 0 sinon ; lit sensitivePaths', () => {
  const root = templateCopy();
  const script = join(root, '.claude/skills/team/scripts/sensitive.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root });

  const hit = run('src/a.ts', 'package.json');
  assert.equal(hit.status, 1);
  assert.match(hit.stdout, /package\.json\s+dependencies/);
  assert.equal(run('src/a.ts').status, 0);
  assert.equal(run().status, 2);

  const teamPath = join(root, '.claude/team.json');
  writeFileSync(teamPath, JSON.stringify({ ...JSON.parse(readFileSync(teamPath, 'utf8')), sensitivePaths: ['infra/**'] }));
  assert.equal(run('infra/main.tf').status, 1);
});
