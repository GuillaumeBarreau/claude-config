#!/usr/bin/env node
// Hook PreToolUse (Read, Edit, Write, NotebookEdit, Grep) : protège les secrets et les
// garde-fous eux-mêmes.
//
// - deny : lire ou écrire un fichier de secrets (.env, clé privée) ;
// - deny : l'agent implementer écrit dans .claude/ ou .agent-runs/ (l'état du run et la
//   configuration appartiennent à l'orchestrateur et au projet) ;
// - ask  : modifier les réglages ou les hooks de l'équipe — un agent ne désactive pas
//   ses propres garde-fous sans l'accord de l'utilisateur.

import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { emitDecision, failClosed, isSecretPath, PROJECT_DIR, readPayload } from './lib.mjs';

const HOOK = 'guard-files';
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

const projectRelative = (projectDir, path) => {
  const rel = relative(resolve(projectDir), resolve(projectDir, path)).split('\\').join('/');
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
};

/**
 * @param ctx { projectDir, agentType }
 * @returns {{decision: 'deny'|'ask', reason: string} | null}
 */
export function evaluateFile(toolName, input, ctx) {
  const paths = [input?.file_path, input?.notebook_path, input?.path].filter((p) => typeof p === 'string' && p);
  if (WRITE_TOOLS.includes(toolName) && !paths.length) throw new Error('chemin du fichier absent');
  for (const path of paths) {
    if (isSecretPath(path)) return { decision: 'deny', reason: `fichier de secrets « ${path} » : ni lecture ni écriture` };
  }
  if (!WRITE_TOOLS.includes(toolName)) return null;

  for (const path of paths) {
    const rel = projectRelative(ctx.projectDir, path);
    if (rel === null) continue;
    if (ctx.agentType === 'implementer' && /^(\.claude|\.agent-runs)(\/|$)/.test(rel)) {
      return { decision: 'deny', reason: `l'implementer ne modifie ni .claude/ ni .agent-runs/ (${rel}) : c'est le rôle de l'orchestrateur` };
    }
    if (/^\.claude\/(settings(\.local)?\.json|hooks\/team\/)/.test(rel)) {
      return { decision: 'ask', reason: `modification des garde-fous de l'équipe (${rel}) : accord explicite requis` };
    }
  }
  return null;
}

function main() {
  try {
    const payload = readPayload();
    const result = evaluateFile(payload.tool_name, payload.tool_input, {
      projectDir: process.env.CLAUDE_PROJECT_DIR || PROJECT_DIR,
      agentType: payload.agent_type ?? null,
    });
    emitDecision(result, HOOK);
  } catch (err) {
    failClosed(HOOK, err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
