// Outils communs aux hooks de l'équipe. Claude Code transmet le contexte d'un hook en
// JSON sur stdin (jamais en variables d'environnement ni en arguments). Un hook de
// garde qui ne comprend pas son entrée bloque : un garde qui laisse passer en cas de
// doute est pire que pas de garde.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** .claude/ du projet : ce fichier est dans .claude/hooks/team/. */
export const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECT_DIR = dirname(CLAUDE_DIR);

export function readPayload() {
  const raw = readFileSync(0, 'utf8');
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object') throw new Error('payload JSON attendu');
  return payload;
}

export function teamConfig() {
  try {
    return JSON.parse(readFileSync(join(CLAUDE_DIR, 'team.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

/** Décision PreToolUse : deny (refus), ask (accord de l'utilisateur), rien = suite normale. */
export function emitDecision(result, hookName) {
  if (!result) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: `[${hookName}] ${result.reason}`,
    },
  }));
}

export function failClosed(hookName, err) {
  process.stderr.write(`[${hookName}] entrée illisible : action bloquée par précaution (${err.message})\n`);
  process.exit(2);
}

/** deny l'emporte sur ask. */
export function strongest(results) {
  return results.find((r) => r && r.decision === 'deny') ?? results.find((r) => r && r.decision === 'ask') ?? null;
}

/** Fichier de secrets : .env, .env.local… (pas .env.example), clés privées. */
const SAFE_ENV_SUFFIXES = ['example', 'sample', 'template', 'dist', 'defaults'];
export function isSecretPath(path) {
  const base = String(path).split(/[\\/]/).pop().toLowerCase();
  const env = base.match(/^\.env(?:\.(.+))?$/);
  if (env) return !env[1] || !SAFE_ENV_SUFFIXES.includes(env[1].split('.').pop());
  return /\.(pem|key|p12|pfx)$/.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base);
}
