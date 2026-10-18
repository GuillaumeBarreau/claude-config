// Lancement de claude en mode non interactif pour le banc. spawn est injectable : les
// tests n'appellent jamais le vrai claude.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Outils autorisés sans demande pendant un run du banc. Les hooks de l'équipe
 * s'appliquent toujours : push et PR restent soumis à accord, donc refusés en -p.
 */
export const BENCH_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Task', 'Skill', 'TodoWrite',
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)',
  'Bash(git branch*)', 'Bash(git switch*)', 'Bash(git checkout*)', 'Bash(git add*)',
  'Bash(git commit*)', 'Bash(git rev-parse*)', 'Bash(git ls-files*)',
  'Bash(npm test*)', 'Bash(node *)',
];

/** Arguments de `claude -p` : la demande d'abord, les listes variadiques à la fin. */
// Pas de plafond de coût par défaut : avec un abonnement, rien n'est facturé (l'usage
// est décompté de l'abonnement). --max-turns reste la protection contre un run qui
// s'emballe ; budgetUsd n'est transmis que s'il est demandé.
export function claudeArgs({ request, budgetUsd = null, maxTurns = 300, allowedTools = BENCH_ALLOWED_TOOLS }) {
  return [
    '-p', `/team ${request}`,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    ...(budgetUsd ? ['--max-budget-usd', String(budgetUsd)] : []),
    '--max-turns', String(maxTurns),
    '--allowedTools', ...allowedTools,
  ];
}

/** Environnement de l'enfant : sans CLAUDECODE, qui le ferait se croire imbriqué. */
export function childEnv(env = process.env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) if (key.toUpperCase() === 'CLAUDECODE') delete copy[key];
  return copy;
}

const pathValue = (env) => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] ?? '' : '';
};

/**
 * Sous Windows, claude peut être un .exe (installateur natif) ou un .cmd (npm) : le
 * .exe se lance directement, le .cmd passe par cmd.exe (shell: true).
 */
export function resolveClaude({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return { command: 'claude', shell: false };
  const dirs = pathValue(env).split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const [ext, shell] of [['.exe', false], ['.cmd', true]]) {
    for (const dir of dirs) {
      const candidate = win32.join(dir, `claude${ext}`);
      if (exists(candidate)) return { command: candidate, shell };
    }
  }
  throw new Error('claude introuvable dans le PATH (ni claude.exe ni claude.cmd)');
}

/**
 * Argument pour une ligne de commande cmd.exe. Entre guillemets, & | < > ( ) sont
 * neutres, mais " % et les sauts de ligne restent interprétés : refusés.
 */
export function quoteForCmd(arg) {
  const s = String(arg);
  if (/["%\r\n]/.test(s)) throw new Error(`argument refusé pour cmd.exe (" % ou saut de ligne) : ${s}`);
  return `"${s}"`;
}

/** Lance claude ; résout avec { code, stdout, stderr }. */
export function runClaude({ args, cwd, env = childEnv(), spawn = nodeSpawn, platform = process.platform, exists = existsSync, onStderr }) {
  const { command, shell } = resolveClaude({ platform, env, exists });
  // Avec le shell, une seule ligne déjà citée (Node déconseille args + shell: true).
  const finalCommand = shell ? [command, ...args].map(quoteForCmd).join(' ') : command;
  const finalArgs = shell ? [] : args;
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(finalCommand, finalArgs, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => {
      stderr += d;
      onStderr?.(String(d));
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}
