#!/usr/bin/env node
// Installe ou met à jour la configuration de l'équipe d'agents dans un projet.
//
// Usage : node install.mjs <dossier-du-projet> [--dry-run] [--force] [--ignore-claude | --no-ignore-claude]
//         node install.mjs <dossier-du-projet> --local [--dry-run] [--force]
//
// - Copie template/.claude/ dans <projet>/.claude/.
// - Un manifeste (.claude/claude-config.manifest.json) garde l'empreinte de chaque
//   fichier installé. À la mise à jour, un fichier modifié localement n'est jamais
//   écrasé : il est signalé en conflit (sauf --force).
// - Les fichiers qui appartiennent au projet (team.json, skills de conventions) sont
//   créés une fois, puis jamais remplacés ni supprimés, même avec --force. Seule
//   exception : les clés `agents` de team.json qui portent un nom d'agent d'avant 0.10
//   (sans préfixe cc-) sont renommées, valeur conservée (ADR 0012).
// - settings.json est fusionné : les hooks de l'équipe (commandes sous
//   .claude/hooks/team/) et ses permissions remplacent ceux de l'installation
//   précédente ; tout le reste du fichier du projet est conservé.
// - Ajoute .agent-runs/ et .agent-reviews/ (revues de PR) au .gitignore du projet.
// - Propose (terminal interactif) ou applique (--ignore-claude) l'ajout de .claude/ au
//   .gitignore, seulement si aucune entrée équivalente n'y est déjà ; ajout en fin de
//   fichier, le reste n'est jamais modifié.
// - --local (usage personnel, rien de visible pour Git ni pour les collègues) : les
//   réglages vont dans .claude/settings.local.json, le .gitignore n'est pas touché, et
//   chaque fichier installé est inscrit dans l'exclusion locale du dépôt
//   (.git/info/exclude, via `git rev-parse --git-path info/exclude`), dans un bloc entre
//   deux marqueurs réécrit à chaque passage. Jamais .claude/ en entier, jamais un fichier
//   que le projet avait déjà. Le mode est mémorisé dans le manifeste ; --no-local
//   repasse en mode partagé et retire le bloc. Un fichier déjà suivi par Git est
//   signalé : l'exclusion ne le cache pas.
//
// Sortie : 0 si tout est appliqué, 2 s'il reste des conflits, 1 en cas d'erreur.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LEGACY_AGENTS } from './template/.claude/skills/team/scripts/deliverable.mjs';
import { createExec } from './template/.claude/skills/team/scripts/gh.mjs';

const REPO_DIR = dirname(fileURLToPath(import.meta.url));
export const MANIFEST = 'claude-config.manifest.json';
export const PROJECT_OWNED = [
  'team.json',
  'skills/conventions-backend/SKILL.md',
  'skills/conventions-frontend/SKILL.md',
];
export const MERGED = 'settings.json';
export const LOCAL_MERGED = 'settings.local.json';
export const EXCLUDE_BEGIN = '# >>> claude-config (install.mjs --local) — ne pas modifier à la main';
export const EXCLUDE_END = '# <<< claude-config';
const isTeamHook = (hook) => typeof hook?.command === 'string' && hook.command.includes('.claude/hooks/team/');
const hasTeamHooks = (settings) => Object.values(settings?.hooks ?? {}).flat().some((g) => (g?.hooks ?? []).some(isTeamHook));
export const GITIGNORE_ENTRY = '.agent-runs/';
export const REVIEWS_IGNORE_ENTRY = '.agent-reviews/';
export const CLAUDE_IGNORE_ENTRY = '.claude/';
const variantsOf = (name) => [name, `${name}/`, `/${name}`, `/${name}/`, `${name}/*`, `/${name}/*`, `${name}/**`, `/${name}/**`];
const GITIGNORE_VARIANTS = variantsOf('.agent-runs');
const REVIEWS_IGNORE_VARIANTS = variantsOf('.agent-reviews');
const CLAUDE_IGNORE_VARIANTS = variantsOf('.claude');

/** Le .gitignore du projet contient-il déjà l'une de ces entrées (lignes exactes) ? */
export function gitignoreHas(projectDir, variants) {
  const path = join(projectDir, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return text.split(/\r?\n/).map((l) => l.trim()).some((l) => variants.includes(l));
}

/** Ajoute l'entrée à la fin du .gitignore (créé s'il manque), sans toucher au reste. */
function appendGitignore(projectDir, entry) {
  const path = join(projectDir, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${text}${prefix}${entry}\n`);
}

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

/** Mode de l'installation en place : 'local', 'shared', ou null (non installé ou manifeste illisible). */
export function installedMode(projectDir) {
  try {
    const previous = readManifest(join(projectDir, '.claude', MANIFEST));
    return previous ? (previous.mode === 'local' ? 'local' : 'shared') : null;
  } catch {
    return null;
  }
}

/**
 * Dépôt Git du projet, par git lui-même (worktree compris, où .git est un fichier) :
 * racine, préfixe du projet dans le dépôt (`apps/web/` ou ``) et fichier d'exclusion
 * locale. Hors dépôt : erreur, rien n'est écrit.
 */
function gitRepoOf(exec, projectDir) {
  const res = exec('git', ['rev-parse', '--show-toplevel', '--show-prefix', '--git-path', 'info/exclude']);
  if (res.code !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim().split(/\r?\n/)[0] || 'git indisponible';
    throw new Error(`${projectDir} : pas un dépôt Git, --local n'a pas de fichier d'exclusion locale où écrire (${detail})`);
  }
  const [toplevel = '', prefix = '', excludeRel = ''] = res.stdout.split(/\r?\n/).map((l) => l.trim());
  if (!excludeRel) throw new Error(`${projectDir} : git rev-parse n'a pas donné le fichier d'exclusion locale`);
  return { toplevel, prefix: prefix.replace(/\/+$/, ''), excludePath: resolve(projectDir, excludeRel) };
}

/** Parmi ces chemins (relatifs au projet, séparateur /), ceux que Git suit déjà. */
function trackedByGit(exec, paths) {
  if (!paths.length) return [];
  const res = exec('git', ['ls-files', '-z', '--', ...paths]);
  if (res.code !== 0) return [];
  return res.stdout.split('\0').filter(Boolean);
}

/**
 * Remplace (ou ajoute en fin) le bloc entre EXCLUDE_BEGIN et EXCLUDE_END par `lines`
 * (marqueurs compris ; [] retire le bloc). Le reste du fichier et ses fins de ligne
 * sont conservés.
 */
export function replaceExcludeBlock(text, lines) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const current = text === '' ? [] : text.split(/\r?\n/);
  if (current.length && current[current.length - 1] === '') current.pop();
  const begin = current.indexOf(EXCLUDE_BEGIN);
  if (begin === -1) {
    current.push(...lines);
  } else {
    const end = current.indexOf(EXCLUDE_END, begin);
    current.splice(begin, (end === -1 ? current.length : end + 1) - begin, ...lines);
  }
  return current.length ? `${current.join(eol)}${eol}` : '';
}

/** Lignes du bloc d'exclusion : chemins ancrés à la racine du dépôt, triés. */
export function excludeBlock(prefix, paths) {
  const root = prefix ? `/${prefix}/` : '/';
  return [EXCLUDE_BEGIN, ...[...new Set(paths)].sort().map((p) => `${root}${p}`), EXCLUDE_END];
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

/**
 * team.json d'avant 0.10 : renomme les clés `agents` sans préfixe (implementer →
 * cc-implementer) à leur place, valeur conservée ; une clé déjà préfixée l'emporte.
 * Renvoie la configuration migrée, ou null s'il n'y a rien à migrer.
 */
export function migrateTeamAgents(config) {
  const agents = config?.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return null;
  if (!Object.keys(agents).some((key) => key in LEGACY_AGENTS)) return null;
  const migrated = {};
  for (const [key, value] of Object.entries(agents)) {
    const name = LEGACY_AGENTS[key] ?? key;
    if (!(name in migrated) || !(key in LEGACY_AGENTS)) migrated[name] = value;
  }
  return { ...config, agents: migrated };
}

/** Migration de <projet>/.claude/team.json ; un fichier illisible n'est jamais touché. */
function migrateTeamFile(dest, dryRun) {
  let migrated;
  try {
    migrated = migrateTeamAgents(JSON.parse(readFileSync(dest, 'utf8').replace(/^﻿/, '')));
  } catch {
    return false;
  }
  if (!migrated) return false;
  if (!dryRun) writeFileSync(dest, `${JSON.stringify(migrated, null, 2)}\n`);
  return true;
}

/**
 * Applique la fusion du template settings.json dans <projet>/.claude/<name>
 * (settings.json, ou settings.local.json en mode local) ; un fichier illisible n'est
 * jamais touché.
 */
function installSettings({ templateDir, claudeDir, name, previousAllow, dryRun }) {
  const source = join(templateDir, MERGED);
  if (!existsSync(source)) return { action: null, allow: [] };
  const template = JSON.parse(readFileSync(source, 'utf8'));
  const allow = template.permissions?.allow ?? [];
  const dest = join(claudeDir, name);
  let project = null;
  if (existsSync(dest)) {
    try {
      project = JSON.parse(readFileSync(dest, 'utf8').replace(/^﻿/, ''));
    } catch {
      return { action: 'conflict', allow: previousAllow };
    }
  }
  const merged = mergeSettings(project, template, previousAllow);
  if (project && JSON.stringify(merged) === JSON.stringify(project)) return { action: 'unchanged', allow };
  if (!dryRun) {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(dest, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return { action: project ? 'merge' : 'add', allow };
}

/**
 * Calcule (et applique sauf dryRun) l'installation. Renvoie la liste des actions :
 * { file, action } avec action ∈ add, update, unchanged, keep, migrate, conflict,
 * overwrite, remove, keep-modified, gitignore, gitignore-reviews, et en mode local
 * exclude (file = fichier d'exclusion, block = texte du bloc), tracked, shared-settings,
 * mode-local / mode-shared, exclude-removed.
 *
 * local : true (--local), false (--no-local) ou undefined (mode mémorisé dans le
 * manifeste, partagé par défaut). exec(cmd, args) : exécuteur de git, injectable.
 */
export function install({
  templateDir, projectDir, version, dryRun = false, force = false, ignoreClaude = false, local, exec,
}) {
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`${projectDir} : dossier de projet introuvable`);
  }
  if (samePath(projectDir, dirname(templateDir))) {
    throw new Error('Le projet cible est le dossier template lui-même');
  }
  const claudeDir = join(projectDir, '.claude');
  const manifestPath = join(claudeDir, MANIFEST);
  const previous = readManifest(manifestPath);
  const previousLocal = previous?.mode === 'local';
  const isLocal = local ?? previousLocal;
  if (isLocal && ignoreClaude) {
    throw new Error('--ignore-claude est sans objet avec --local : le .gitignore du projet n\'est pas modifié');
  }
  const git = exec ?? createExec(projectDir);
  let repo = null;
  if (isLocal) repo = gitRepoOf(git, projectDir);
  else if (previousLocal) {
    try {
      repo = gitRepoOf(git, projectDir);
    } catch {
      // Plus de dépôt Git : il n'y a plus de bloc à retirer.
    }
  }
  const known = previous?.files ?? {};
  const created = new Set(previous?.created ?? []);
  const files = {};
  const actions = [];
  // Chemins (relatifs au projet, séparateur /) que l'installeur gère et doit cacher.
  const managed = new Set();
  const write = (rel, content) => {
    if (dryRun) return;
    const dest = join(claudeDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  };

  const settingsName = isLocal ? LOCAL_MERGED : MERGED;
  const settings = installSettings({
    templateDir, claudeDir, name: settingsName, dryRun,
    previousAllow: previousLocal === isLocal ? previous?.settingsAllow ?? [] : [],
  });
  if (settings.action) actions.push({ file: settingsName, action: settings.action });
  if (settings.action && settings.action !== 'conflict') managed.add(`.claude/${settingsName}`);
  // Vérifié avant toute écriture : un fichier que Git suit déjà ne sera pas caché.
  const tracked = isLocal
    ? trackedByGit(git, [...listFiles(templateDir).filter((rel) => rel !== MERGED), settingsName, MANIFEST].map((rel) => `.claude/${rel}`))
    : [];
  if (isLocal && existsSync(join(claudeDir, MERGED))) {
    try {
      if (hasTeamHooks(JSON.parse(readFileSync(join(claudeDir, MERGED), 'utf8').replace(/^﻿/, '')))) {
        actions.push({ file: MERGED, action: 'shared-settings' });
      }
    } catch {
      // Illisible : pas notre fichier en mode local, on ne le signale pas.
    }
  }

  for (const rel of listFiles(templateDir)) {
    if (rel === MERGED) continue;
    const source = readFileSync(join(templateDir, rel));
    const dest = join(claudeDir, rel);
    const sourceHash = hashOf(source);

    if (PROJECT_OWNED.includes(rel)) {
      if (existsSync(dest)) {
        const migrated = rel === 'team.json' && migrateTeamFile(dest, dryRun);
        actions.push({ file: rel, action: migrated ? 'migrate' : 'keep' });
      } else {
        write(rel, source);
        created.add(rel);
        actions.push({ file: rel, action: 'add' });
      }
      if (created.has(rel)) managed.add(`.claude/${rel}`);
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
      managed.add(`.claude/${rel}`);
      actions.push({ file: rel, action: known[rel] ? 'restore' : 'add' });
      continue;
    }
    const destHash = hashOf(readFileSync(dest));
    if (destHash === sourceHash) {
      files[rel] = sourceHash;
      managed.add(`.claude/${rel}`);
      actions.push({ file: rel, action: 'unchanged' });
    } else if (known[rel] === destHash || force) {
      write(rel, source);
      files[rel] = sourceHash;
      managed.add(`.claude/${rel}`);
      actions.push({ file: rel, action: known[rel] === destHash ? 'update' : 'overwrite' });
    } else {
      // Modifié localement, ou fichier du projet qui porte le même nom : on n'y touche
      // pas, et on garde l'ancienne empreinte pour qu'il reste signalé.
      if (known[rel]) {
        files[rel] = known[rel];
        managed.add(`.claude/${rel}`);
      }
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

  if (previous && previousLocal !== isLocal) actions.push({ file: MANIFEST, action: isLocal ? 'mode-local' : 'mode-shared' });
  if (!previous && isLocal) actions.push({ file: MANIFEST, action: 'mode-local' });

  if (isLocal) {
    for (const path of tracked) if (managed.has(path)) actions.push({ file: path, action: 'tracked' });
    managed.add(`.claude/${MANIFEST}`);
    managed.add(GITIGNORE_ENTRY);
    managed.add(REVIEWS_IGNORE_ENTRY);
    const lines = excludeBlock(repo.prefix, [...managed]);
    const current = existsSync(repo.excludePath) ? readFileSync(repo.excludePath, 'utf8') : '';
    const next = replaceExcludeBlock(current, lines);
    if (!dryRun && next !== current) {
      mkdirSync(dirname(repo.excludePath), { recursive: true });
      writeFileSync(repo.excludePath, next);
    }
    actions.push({ file: repo.excludePath, action: 'exclude', block: `${lines.join('\n')}\n` });
  } else {
    if (repo && existsSync(repo.excludePath)) {
      const current = readFileSync(repo.excludePath, 'utf8');
      if (current.includes(EXCLUDE_BEGIN)) {
        if (!dryRun) writeFileSync(repo.excludePath, replaceExcludeBlock(current, []));
        actions.push({ file: repo.excludePath, action: 'exclude-removed' });
      }
    }
    if (!gitignoreHas(projectDir, GITIGNORE_VARIANTS)) {
      if (!dryRun) appendGitignore(projectDir, GITIGNORE_ENTRY);
      actions.push({ file: '../.gitignore', action: 'gitignore' });
    }
    if (!gitignoreHas(projectDir, REVIEWS_IGNORE_VARIANTS)) {
      if (!dryRun) appendGitignore(projectDir, REVIEWS_IGNORE_ENTRY);
      actions.push({ file: '../.gitignore', action: 'gitignore-reviews' });
    }
    // Configuration Claude hors de Git : seulement sur demande (elle n'est alors plus
    // partagée avec l'équipe par le dépôt).
    if (ignoreClaude) {
      if (gitignoreHas(projectDir, CLAUDE_IGNORE_VARIANTS)) {
        actions.push({ file: '../.gitignore', action: 'gitignore-claude-present' });
      } else {
        if (!dryRun) appendGitignore(projectDir, CLAUDE_IGNORE_ENTRY);
        actions.push({ file: '../.gitignore', action: 'gitignore-claude' });
      }
    }
  }

  if (!dryRun) {
    mkdirSync(claudeDir, { recursive: true });
    const manifest = {
      source: 'claude-config', version, installedAt: new Date().toISOString(), mode: isLocal ? 'local' : 'shared',
      files, settingsAllow: settings.allow, created: [...created].sort(),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return actions;
}

const LABELS = {
  add: 'ajouté',
  update: 'mis à jour',
  unchanged: 'inchangé',
  keep: 'conservé (appartient au projet)',
  migrate: 'migré (clés agents renommées en cc-)',
  conflict: 'CONFLIT — modifié localement, non remplacé',
  overwrite: 'écrasé (--force)',
  remove: 'supprimé (retiré du template)',
  'keep-modified': 'conservé (retiré du template mais modifié localement)',
  'deleted-locally': 'non recréé (supprimé dans le projet ; --force pour le restaurer)',
  restore: 'restauré (--force)',
  merge: "fusionné (hooks et permissions de l'équipe)",
  'unsafe-path': 'IGNORÉ — chemin du manifeste hors de .claude/',
  gitignore: `ajout de ${GITIGNORE_ENTRY}`,
  'gitignore-reviews': `ajout de ${REVIEWS_IGNORE_ENTRY}`,
  'gitignore-claude': `ajout de ${CLAUDE_IGNORE_ENTRY}`,
  'gitignore-claude-present': `${CLAUDE_IGNORE_ENTRY} déjà ignoré`,
  exclude: 'exclusion locale Git (bloc réécrit)',
  'exclude-removed': 'bloc d\'exclusion locale retiré',
  tracked: 'SUIVI PAR GIT — l\'exclusion locale ne le cache pas',
  'shared-settings': 'hooks de l\'équipe d\'une installation non locale : non modifié',
  'mode-local': 'mode local mémorisé (relance sans option pour le garder, --no-local pour en sortir)',
  'mode-shared': 'mode partagé : le mode local précédent est abandonné',
};

/** Question posée dans le terminal (o/N). */
async function askInTerminal(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const IGNORE_QUESTION = `Ajouter ${CLAUDE_IGNORE_ENTRY} au .gitignore du projet ? La configuration Claude ne sera `
  + 'alors plus partagée avec l\'équipe par Git. [o/N] ';

/**
 * Ligne de commande. deps (tests) : interactive, ask(question), log, warn, error.
 * Sortie : 0 tout appliqué, 2 conflits restants, 1 erreur.
 */
export async function main(argv, deps = {}) {
  const {
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask = askInTerminal,
    log = console.log, warn = console.warn, error = console.error,
  } = deps;
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    error('Usage : node install.mjs <dossier-du-projet> [--dry-run] [--force] [--ignore-claude | --no-ignore-claude]\n'
      + '        node install.mjs <dossier-du-projet> --local [--dry-run] [--force]');
    return 1;
  }
  const projectDir = resolve(target);
  const { version } = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8'));
  const local = args.includes('--local') ? true : (args.includes('--no-local') ? false : undefined);
  const isLocal = local ?? installedMode(projectDir) === 'local';
  if (isLocal && (args.includes('--ignore-claude') || args.includes('--no-ignore-claude'))) {
    error('erreur : --ignore-claude et --no-ignore-claude sont sans objet avec --local (le .gitignore du projet n\'est pas modifié '
      + 'en mode local ; --no-local pour repasser en mode partagé)');
    return 1;
  }
  if (!isLocal && !existsSync(join(projectDir, '.git'))) {
    warn(`avertissement : ${projectDir} n'est pas la racine d'un dépôt Git`);
  }

  // .claude/ dans le .gitignore : option explicite, sinon question si le terminal est
  // interactif et que l'entrée n'existe pas déjà ; sinon rien. Jamais en mode local.
  let ignoreClaude = false;
  let ignoreHint = false;
  if (isLocal) ignoreClaude = false;
  else if (args.includes('--ignore-claude')) ignoreClaude = true;
  else if (!args.includes('--no-ignore-claude') && existsSync(projectDir)
      && !gitignoreHas(projectDir, CLAUDE_IGNORE_VARIANTS)) {
    if (interactive && !dryRun) ignoreClaude = /^\s*(o|oui|y|yes)\s*$/i.test(await ask(IGNORE_QUESTION));
    else ignoreHint = true;
  }

  let actions;
  try {
    actions = install({ templateDir: join(REPO_DIR, 'template', '.claude'), projectDir, version, dryRun, force, ignoreClaude, local });
  } catch (err) {
    error(`erreur : ${err.message}`);
    return 1;
  }
  log(`${dryRun ? '[simulation] ' : ''}claude-config ${version} → ${projectDir}${isLocal ? ' (mode local)' : ''}`);
  for (const { file, action } of actions) {
    if (action !== 'unchanged') log(`  ${LABELS[action].padEnd(28)} ${file}`);
  }
  const unchanged = actions.filter((a) => a.action === 'unchanged').length;
  if (unchanged) log(`  ${unchanged} fichier(s) inchangé(s)`);
  const exclude = actions.find((a) => a.action === 'exclude');
  if (exclude && dryRun) log(`\nBloc qui serait écrit dans ${exclude.file} :\n${exclude.block}`);
  const trackedFiles = actions.filter((a) => a.action === 'tracked');
  if (trackedFiles.length) {
    log(`\n${trackedFiles.length} fichier(s) déjà suivi(s) par Git : l'exclusion locale ne les cache pas, ils resteront visibles `
      + 'dans git status s\'ils changent (git rm --cached pour cesser de les suivre, ou laisse-les partagés).');
  }
  if (ignoreHint) {
    log(`\n${CLAUDE_IGNORE_ENTRY} n'est pas dans le .gitignore : relance avec --ignore-claude pour l'y ajouter `
      + '(ou --no-ignore-claude pour ne plus le proposer dans un script).');
  }
  const conflicts = actions.filter((a) => a.action === 'conflict');
  if (conflicts.length) {
    log(`\n${conflicts.length} conflit(s) : compare avec template/.claude/, puis relance avec --force pour remplacer.`);
    const unreadable = conflicts.find((c) => c.file === MERGED || c.file === LOCAL_MERGED);
    if (unreadable) {
      log(`${unreadable.file} est illisible : corrige son JSON puis relance (il n'est jamais écrasé, même avec --force).`);
    }
    return 2;
  }
  if (!dryRun) {
    log('\nUne session Claude Code déjà ouverte dans ce projet ne charge ni les nouveaux hooks ni les nouveaux agents : '
      + 'ferme-la et relance-la avant /team ou /team-review (sinon la confirmation avant publication sur GitHub et '
      + 'l\'enregistrement des livrables sont inactifs).');
    log('Étape suivante : dans le projet, lance Claude Code puis /team-init.');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code));
}
