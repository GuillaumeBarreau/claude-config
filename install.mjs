#!/usr/bin/env node
// Installe ou met à jour la configuration de l'équipe d'agents dans un projet.
//
// Usage : node install.mjs <dossier-du-projet> [--dry-run] [--force]
//
// - Copie template/.claude/ dans <projet>/.claude/.
// - Un manifeste (.claude/claude-config.manifest.json) garde l'empreinte de chaque
//   fichier installé. À la mise à jour, un fichier modifié localement n'est jamais
//   écrasé : il est signalé en conflit (sauf --force).
// - Les fichiers qui appartiennent au projet (team.json, skills de conventions) sont
//   créés une fois, puis jamais remplacés ni supprimés, même avec --force.
// - settings.json est fusionné : les hooks de l'équipe (commandes sous
//   .claude/hooks/team/) et ses permissions remplacent ceux de l'installation
//   précédente ; tout le reste du fichier du projet est conservé.
// - Ajoute .agent-runs/ au .gitignore du projet.
//
// Sortie : 0 si tout est appliqué, 2 s'il reste des conflits, 1 en cas d'erreur.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_DIR = dirname(fileURLToPath(import.meta.url));
export const MANIFEST = 'claude-config.manifest.json';
export const PROJECT_OWNED = [
  'team.json',
  'skills/conventions-backend/SKILL.md',
  'skills/conventions-frontend/SKILL.md',
];
export const MERGED = 'settings.json';
const isTeamHook = (hook) => typeof hook?.command === 'string' && hook.command.includes('.claude/hooks/team/');
export const GITIGNORE_ENTRY = '.agent-runs/';
const GITIGNORE_VARIANTS = ['.agent-runs', '.agent-runs/', '/.agent-runs', '/.agent-runs/', '.agent-runs/*', '/.agent-runs/*'];

const samePath = (a, b) => (process.platform === 'win32'
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
  : resolve(a) === resolve(b));

// Un chemin du manifeste vient d'un fichier du projet, modifiable par n'importe qui :
// il ne doit jamais permettre d'écrire ou de supprimer hors de .claude/.
const insideDir = (dir, rel) => {
  const r = relative(dir, resolve(dir, rel));
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

// Fins de ligne normalisées : Git peut convertir LF/CRLF au checkout, ce qui ne doit
// pas faire passer un fichier intact pour une modification locale.
export const hashOf = (buffer) => createHash('sha256').update(buffer.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    const rel = relative(base, full).split(sep).join('/');
    return rel === MANIFEST ? [] : [rel];
  });
}

function readManifest(path) {
  if (!existsSync(path)) return null;
  const invalid = `${path} : manifeste illisible ou invalide — corrige-le ou supprime-le pour réinstaller`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(invalid);
  }
  const files = manifest?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)
      || Object.values(files).some((h) => typeof h !== 'string')) {
    throw new Error(invalid);
  }
  return manifest;
}

/**
 * Fusionne les réglages du template dans ceux du projet, sans modifier les entrées.
 * - hooks : ceux de l'équipe sont retirés puis remis d'après le template ;
 * - permissions.allow : ajout des entrées du template, retrait de celles installées
 *   auparavant (previousAllow) et retirées du template.
 */
export function mergeSettings(project, template, previousAllow = []) {
  const merged = structuredClone(project ?? {});
  const hooks = merged.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isTeamHook(h)) }))
      .filter((group) => group.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  for (const [event, groups] of Object.entries(template.hooks ?? {})) {
    hooks[event] = [...(hooks[event] ?? []), ...structuredClone(groups)];
  }
  if (Object.keys(hooks).length) merged.hooks = hooks;
  else delete merged.hooks;

  const wanted = template.permissions?.allow ?? [];
  if (wanted.length || previousAllow.length) {
    const current = merged.permissions?.allow ?? [];
    const allow = current.filter((a) => wanted.includes(a) || !previousAllow.includes(a));
    for (const a of wanted) if (!allow.includes(a)) allow.push(a);
    merged.permissions = { ...(merged.permissions ?? {}), allow };
  }
  return merged;
}

/** Applique la fusion de settings.json ; un fichier illisible n'est jamais touché. */
function installSettings({ templateDir, claudeDir, previous, dryRun }) {
  const source = join(templateDir, MERGED);
  if (!existsSync(source)) return { action: null, allow: [] };
  const template = JSON.parse(readFileSync(source, 'utf8'));
  const allow = template.permissions?.allow ?? [];
  const dest = join(claudeDir, MERGED);
  let project = null;
  if (existsSync(dest)) {
    try {
      project = JSON.parse(readFileSync(dest, 'utf8').replace(/^﻿/, ''));
    } catch {
      return { action: 'conflict', allow: previous?.settingsAllow ?? [] };
    }
  }
  const merged = mergeSettings(project, template, previous?.settingsAllow ?? []);
  if (project && JSON.stringify(merged) === JSON.stringify(project)) return { action: 'unchanged', allow };
  if (!dryRun) {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(dest, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return { action: project ? 'merge' : 'add', allow };
}

/**
 * Calcule (et applique sauf dryRun) l'installation. Renvoie la liste des actions :
 * { file, action } avec action ∈ add, update, unchanged, keep, conflict, overwrite,
 * remove, keep-modified, gitignore.
 */
export function install({ templateDir, projectDir, version, dryRun = false, force = false }) {
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`${projectDir} : dossier de projet introuvable`);
  }
  if (samePath(projectDir, dirname(templateDir))) {
    throw new Error('Le projet cible est le dossier template lui-même');
  }
  const claudeDir = join(projectDir, '.claude');
  const manifestPath = join(claudeDir, MANIFEST);
  const previous = readManifest(manifestPath);
  const known = previous?.files ?? {};
  const files = {};
  const actions = [];
  const write = (rel, content) => {
    if (dryRun) return;
    const dest = join(claudeDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  };

  const settings = installSettings({ templateDir, claudeDir, previous, dryRun });
  if (settings.action) actions.push({ file: MERGED, action: settings.action });

  for (const rel of listFiles(templateDir)) {
    if (rel === MERGED) continue;
    const source = readFileSync(join(templateDir, rel));
    const dest = join(claudeDir, rel);
    const sourceHash = hashOf(source);

    if (PROJECT_OWNED.includes(rel)) {
      if (existsSync(dest)) actions.push({ file: rel, action: 'keep' });
      else {
        write(rel, source);
        actions.push({ file: rel, action: 'add' });
      }
      continue;
    }
    if (!existsSync(dest)) {
      if (known[rel] && !force) {
        // Supprimé volontairement dans le projet : c'est un choix local, respecté.
        files[rel] = known[rel];
        actions.push({ file: rel, action: 'deleted-locally' });
        continue;
      }
      write(rel, source);
      files[rel] = sourceHash;
      actions.push({ file: rel, action: known[rel] ? 'restore' : 'add' });
      continue;
    }
    const destHash = hashOf(readFileSync(dest));
    if (destHash === sourceHash) {
      files[rel] = sourceHash;
      actions.push({ file: rel, action: 'unchanged' });
    } else if (known[rel] === destHash || force) {
      write(rel, source);
      files[rel] = sourceHash;
      actions.push({ file: rel, action: known[rel] === destHash ? 'update' : 'overwrite' });
    } else {
      // Modifié localement, ou fichier du projet qui porte le même nom : on n'y touche
      // pas, et on garde l'ancienne empreinte pour qu'il reste signalé.
      if (known[rel]) files[rel] = known[rel];
      actions.push({ file: rel, action: 'conflict' });
    }
  }

  // Fichiers installés autrefois et retirés du template.
  for (const [rel, hash] of Object.entries(known)) {
    if (rel in files || PROJECT_OWNED.includes(rel) || rel === MANIFEST || rel === MERGED) continue;
    if (!insideDir(claudeDir, rel)) {
      actions.push({ file: rel, action: 'unsafe-path' });
      continue;
    }
    const dest = join(claudeDir, rel);
    if (!existsSync(dest)) continue;
    if (hashOf(readFileSync(dest)) === hash) {
      if (!dryRun) rmSync(dest);
      actions.push({ file: rel, action: 'remove' });
    } else {
      actions.push({ file: rel, action: 'keep-modified' });
    }
  }

  const gitignore = join(projectDir, '.gitignore');
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const lines = ignored.split(/\r?\n/).map((l) => l.trim());
  if (!lines.some((l) => GITIGNORE_VARIANTS.includes(l))) {
    if (!dryRun) {
      const prefix = ignored && !ignored.endsWith('\n') ? '\n' : '';
      writeFileSync(gitignore, `${ignored}${prefix}${GITIGNORE_ENTRY}\n`);
    }
    actions.push({ file: '../.gitignore', action: 'gitignore' });
  }

  if (!dryRun) {
    mkdirSync(claudeDir, { recursive: true });
    const manifest = { source: 'claude-config', version, installedAt: new Date().toISOString(), files, settingsAllow: settings.allow };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return actions;
}

const LABELS = {
  add: 'ajouté',
  update: 'mis à jour',
  unchanged: 'inchangé',
  keep: 'conservé (appartient au projet)',
  conflict: 'CONFLIT — modifié localement, non remplacé',
  overwrite: 'écrasé (--force)',
  remove: 'supprimé (retiré du template)',
  'keep-modified': 'conservé (retiré du template mais modifié localement)',
  'deleted-locally': 'non recréé (supprimé dans le projet ; --force pour le restaurer)',
  restore: 'restauré (--force)',
  merge: "fusionné (hooks et permissions de l'équipe)",
  'unsafe-path': 'IGNORÉ — chemin du manifeste hors de .claude/',
  gitignore: `ajout de ${GITIGNORE_ENTRY}`,
};

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage : node install.mjs <dossier-du-projet> [--dry-run] [--force]');
    return 1;
  }
  const projectDir = resolve(target);
  const { version } = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8'));
  if (!existsSync(join(projectDir, '.git'))) {
    console.warn(`avertissement : ${projectDir} n'est pas la racine d'un dépôt Git`);
  }
  let actions;
  try {
    actions = install({ templateDir: join(REPO_DIR, 'template', '.claude'), projectDir, version, dryRun, force });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 1;
  }
  console.log(`${dryRun ? '[simulation] ' : ''}claude-config ${version} → ${projectDir}`);
  for (const { file, action } of actions) {
    if (action !== 'unchanged') console.log(`  ${LABELS[action].padEnd(28)} ${file}`);
  }
  const unchanged = actions.filter((a) => a.action === 'unchanged').length;
  if (unchanged) console.log(`  ${unchanged} fichier(s) inchangé(s)`);
  const conflicts = actions.filter((a) => a.action === 'conflict');
  if (conflicts.length) {
    console.log(`\n${conflicts.length} conflit(s) : compare avec template/.claude/, puis relance avec --force pour remplacer.`);
    if (conflicts.some((c) => c.file === MERGED)) {
      console.log('settings.json est illisible : corrige son JSON puis relance (il n\'est jamais écrasé, même avec --force).');
    }
    return 2;
  }
  if (!dryRun) console.log('\nÉtape suivante : dans le projet, lance Claude Code puis /team-init.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
