#!/usr/bin/env node
// Classe les chemins sensibles : ceux qu'un agent ne modifie pas sans accord de
// l'utilisateur (tâche requiresHuman, jamais en piste quick). Utilisé par check-plan
// (fichiers prévus) et check-scope (fichiers réellement modifiés).
//
// Catégories : dependencies, migrations, ci, auth, secrets, team-config ; custom pour
// les motifs ajoutés par team.json (« sensitivePaths »). Ces motifs AJOUTENT des chemins
// sensibles, ils n'en retirent jamais.
//
// Usage : node .claude/skills/team/scripts/sensitive.mjs <chemin>...
// Sortie : 0 si aucun chemin n'est sensible, 1 sinon (liste sur stdout), 2 si usage.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isSecretPath } from '../../../hooks/team/lib.mjs';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DEPENDENCY_FILES = new Set([
  // npm, yarn, pnpm, bun
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'bun.lockb', 'bun.lock',
  // pip, poetry, uv, pipenv
  'pyproject.toml', 'poetry.lock', 'uv.lock', 'pipfile', 'pipfile.lock', 'setup.py', 'setup.cfg',
  // cargo, go, gem, composer
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'gemfile', 'gemfile.lock',
  'composer.json', 'composer.lock',
  // maven, gradle, .NET
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'gradle.lockfile', 'libs.versions.toml', 'packages.config', 'directory.packages.props',
]);
const DEPENDENCY_PATTERNS = [/^requirements.*\.txt$/, /^constraints.*\.txt$/, /\.gemspec$/, /\.(cs|fs|vb)proj$/];
const CI_FILES = new Set([
  '.gitlab-ci.yml', 'jenkinsfile', 'azure-pipelines.yml', '.pre-commit-config.yaml', 'codeowners',
]);
const AUTH_SEGMENTS = new Set(['auth', 'oauth', 'permission', 'permissions', 'rbac', 'acl', 'security']);

/** Chemin relatif en « / », sans « ./ » initial. */
export const normalizePath = (path) => String(path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');

/** Glob → RegExp : « ** » = plusieurs dossiers, « * » et « ? » restent dans un dossier. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Motif sans « / » : comparé au nom du fichier, à toute profondeur ; sinon au chemin. */
function matchesExtra(path, pattern) {
  const glob = normalizePath(pattern);
  const target = glob.includes('/') ? path : path.split('/').pop();
  return globToRegExp(glob).test(target);
}

function builtinCategory(path) {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const base = segments.at(-1);
  const dirs = segments.slice(0, -1);
  if (isSecretPath(path) || dirs.includes('secrets') || base.startsWith('credentials')) return 'secrets';
  if (dirs[0] === '.claude') return 'team-config';
  if (/(^|\/)\.github\/(workflows|actions)\//.test(lower) || dirs.includes('.circleci') || CI_FILES.has(base)) return 'ci';
  if (dirs.includes('migrations') || dirs.includes('migrate') || dirs.includes('alembic')
    || /(^|\/)prisma\/schema\.prisma$/.test(lower) || /(^|\/)db\/schema\.rb$/.test(lower)) return 'migrations';
  if (DEPENDENCY_FILES.has(base) || DEPENDENCY_PATTERNS.some((re) => re.test(base))
    || (dirs.at(-1) === 'requirements' && base.endsWith('.txt'))) return 'dependencies';
  if (segments.some((s) => AUTH_SEGMENTS.has(s))) return 'auth';
  return null;
}

/**
 * @param paths chemins relatifs à la racine du projet
 * @param extraPatterns motifs « sensitivePaths » de team.json
 * @returns [{ path, category }] pour les seuls chemins sensibles, dans l'ordre reçu
 */
export function sensitiveFiles(paths, extraPatterns = []) {
  const extra = (Array.isArray(extraPatterns) ? extraPatterns : []).filter((p) => typeof p === 'string' && p.trim());
  return (Array.isArray(paths) ? paths : []).flatMap((raw) => {
    const path = normalizePath(raw);
    const category = builtinCategory(path) ?? (extra.some((p) => matchesExtra(path, p)) ? 'custom' : null);
    return category ? [{ path, category }] : [];
  });
}

/** Motifs « sensitivePaths » de .claude/team.json (liste vide si absent ou illisible). */
export function teamSensitivePaths(claudeDir = CLAUDE_DIR) {
  try {
    const team = JSON.parse(readFileSync(join(claudeDir, 'team.json'), 'utf8').replace(/^﻿/, ''));
    return Array.isArray(team.sensitivePaths) ? team.sensitivePaths : [];
  } catch {
    return [];
  }
}

function main(argv) {
  const paths = argv.slice(2);
  if (!paths.length) {
    console.error('Usage : node sensitive.mjs <chemin>...');
    return 2;
  }
  const hits = sensitiveFiles(paths, teamSensitivePaths());
  if (!hits.length) {
    console.log('aucun fichier sensible');
    return 0;
  }
  for (const { path, category } of hits) console.log(`${path}  ${category}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
