// Prépare un projet d'essai pour un scénario du banc : copie du projet fixture dans un
// dossier temporaire, dépôt Git sur main, installation de claude-config, team.json du
// banc, puis commit de l'installation. N'appelle jamais claude.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { install } from '../../install.mjs';
import { META_FILE } from './assert.mjs';

export const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = join(BENCH_DIR, '..');
const SCENARIOS_DIR = join(BENCH_DIR, 'scenarios');
const NAME = /^[\w-]+$/;
const BASE_BRANCH = 'main';

export function listScenarios() {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export function loadScenario(name) {
  if (!NAME.test(String(name)) || !listScenarios().includes(name)) {
    throw new Error(`scénario inconnu : « ${name} » (disponibles : ${listScenarios().join(', ')})`);
  }
  const scenario = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), 'utf8'));
  if (typeof scenario.request !== 'string' || !scenario.request.trim()) {
    throw new Error(`scénario ${name} : « request » manquant`);
  }
  return { name, expect: {}, ...scenario };
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * @param {string} name scénario (enregistré dans .git/claude-bench.json)
 * @param {{ dir?: string }} options dossier cible : absent ou vide ; temporaire par défaut
 * @returns {{ dir: string, baseHead: string, scenario: object }}
 */
export function prepare(name, { dir } = {}) {
  const scenario = loadScenario(name);
  let target;
  if (dir) {
    target = resolve(dir);
    if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} n'est pas vide`);
    mkdirSync(target, { recursive: true });
  } else {
    target = mkdtempSync(join(tmpdir(), `claude-bench-${name}-`));
  }

  cpSync(join(BENCH_DIR, 'fixture'), target, { recursive: true });
  git(target, 'init', '-q', '-b', BASE_BRANCH);
  // Identité locale : le banc ne dépend pas de la configuration Git de la machine.
  git(target, 'config', 'user.name', 'claude-bench');
  git(target, 'config', 'user.email', 'claude-bench@example.invalid');
  git(target, 'config', 'commit.gpgsign', 'false');
  git(target, 'config', 'core.autocrlf', 'false');
  git(target, 'add', '-A');
  git(target, 'commit', '-q', '-m', 'Projet de départ');

  const { version } = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8'));
  const actions = install({ templateDir: join(REPO_DIR, 'template', '.claude'), projectDir: target, version });
  const conflicts = actions.filter((a) => a.action === 'conflict');
  if (conflicts.length) throw new Error(`installation : conflit(s) sur ${conflicts.map((c) => c.file).join(', ')}`);
  writeFileSync(join(target, '.claude', 'team.json'), readFileSync(join(BENCH_DIR, 'team.json')));
  git(target, 'add', '-A');
  git(target, 'commit', '-q', '-m', 'Installation de claude-config');

  const baseHead = git(target, 'rev-parse', BASE_BRANCH);
  const meta = { scenario: name, baseBranch: BASE_BRANCH, baseHead, version, preparedAt: new Date().toISOString() };
  writeFileSync(join(target, '.git', META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  return { dir: target, baseHead, scenario };
}
