#!/usr/bin/env node
// Hook PostToolUse (Edit, Write) : après chaque écriture d'un .agent-runs/<id>/state.json,
// le vérifie avec check-state. Une erreur est renvoyée au modèle (code 2, stderr), qui
// doit corriger l'état avant de continuer. La vérification ne dépend donc plus de la
// mémoire de l'orchestrateur.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkState } from '../../skills/team/scripts/check-state.mjs';
import { readPayload, teamConfig } from './lib.mjs';

const HOOK = 'check-run-state';
const STATE_FILE = /(^|[\\/])\.agent-runs[\\/][^\\/]+[\\/]state\.json$/;

function main() {
  let payload;
  try {
    payload = readPayload();
  } catch (err) {
    process.stderr.write(`[${HOOK}] entrée illisible, vérification sautée (${err.message})\n`);
    process.exit(1);
  }
  const file = payload.tool_input?.file_path;
  if (typeof file !== 'string' || !STATE_FILE.test(file)) return;
  const path = /^([a-zA-Z]:)?[\\/]/.test(file) ? file : join(payload.cwd || process.cwd(), file);

  let errors;
  try {
    const team = teamConfig();
    errors = checkState(JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')), Object.keys(team).length ? team : null);
  } catch (err) {
    errors = [`lecture ou JSON invalide — ${err.message}`];
  }
  if (errors.length) {
    process.stderr.write(`[${HOOK}] ${file} refusé par check-state — corrige l'état sans contourner la règle :\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
