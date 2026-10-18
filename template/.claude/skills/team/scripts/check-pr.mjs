#!/usr/bin/env node
// Vérifie la description de PR d'un run (.agent-runs/<id>/pr.md) avant la porte 4 :
// conventions de pr-conventions.md, et cohérence avec l'état réel du run (statuts des
// contrôles, critères d'acceptation). Une PR qui annonce « passed » pour un contrôle en
// échec est refusée.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team/scripts/check-pr.mjs .agent-runs/<id>
//
// Si pr.md est conforme, écrit pr-body.md (pr.md sans la ligne de titre) et affiche le
// titre : ce sont les arguments de `gh pr create --title … --body-file …`.
// Sortie : 0 si conforme (les avertissements ne font pas échouer), 1 sinon.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const REQUIRED_SECTIONS = ['Résumé', 'Changements', 'Vérification', 'Risques et migrations', 'À vérifier par l\'humain'];
export const MAX_TITLE = 72;
export const DEFAULT_MAX_CHANGED_LINES = 400;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Contenu d'une section « ## Nom » jusqu'à la suivante. */
function section(text, name) {
  const match = text.match(new RegExp(`^## ${escape(name)}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return match ? match[1] : null;
}

function changedLines(projectDir, base, branch) {
  try {
    const out = execFileSync('git', ['diff', '--numstat', `${base}...${branch}`], {
      cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).reduce((sum, line) => {
      const [added, deleted] = line.split('\t');
      return sum + (Number(added) || 0) + (Number(deleted) || 0);
    }, 0);
  } catch {
    return null; // Pas de dépôt ou branche absente : la taille n'est pas vérifiable ici.
  }
}

/** Renvoie { errors, warnings, title }. Écrit pr-body.md si aucune erreur. */
export function checkPr({ claudeDir = CLAUDE_DIR, runDir }) {
  const errors = [];
  const warnings = [];
  const team = readJson(join(claudeDir, 'team.json'));
  const conventions = team.pullRequest ?? {};
  const state = readJson(join(runDir, 'state.json'));
  const text = readFileSync(join(runDir, 'pr.md'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

  // Titre : première ligne non vide, « # … ».
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  const titleMatch = first >= 0 ? lines[first].match(/^#\s+(.+?)\s*$/) : null;
  const title = titleMatch ? titleMatch[1] : null;
  if (!title) errors.push('titre absent : la première ligne de pr.md doit être « # <titre> »');
  else {
    if (title.length > MAX_TITLE) errors.push(`titre de ${title.length} caractères (> ${MAX_TITLE})`);
    if (conventions.titlePattern && !new RegExp(conventions.titlePattern).test(title)) {
      errors.push(`titre « ${title} » : ne respecte pas le format du projet (${conventions.titlePattern})`);
    }
  }

  for (const name of REQUIRED_SECTIONS) {
    if (section(text, name) === null) errors.push(`section « ${name} » absente`);
  }

  // Texte du modèle resté tel quel : <…> hors code (blocs et code en ligne).
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const [placeholder] of prose.matchAll(/<(?!https?:\/\/)[^<>\n]+>/g)) {
    errors.push(`texte du modèle non remplacé : « ${placeholder} »`);
  }

  // Vérification : chaque contrôle du run, avec le statut que state.json a enregistré.
  const verification = section(text, 'Vérification') ?? '';
  const rows = verification.split('\n').filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, '')));
  for (const check of state.checks ?? []) {
    const row = rows.find((cells) => cells[0] === check.name);
    if (!row) {
      errors.push(`contrôle « ${check.name} » absent du tableau de vérification`);
      continue;
    }
    const claimed = row[row.length - 1].toLowerCase();
    if (claimed !== check.status) {
      errors.push(`« ${check.name} » annoncé ${claimed || '(vide)'} alors que state.json dit ${check.status}`);
    }
  }

  if (state.track !== 'quick') {
    const criteria = [...new Set((state.tasks ?? []).flatMap((t) => t.acceptanceCriteria ?? []))];
    for (const ac of criteria) {
      if (!new RegExp(`\\b${escape(ac)}\\b`).test(text)) errors.push(`${ac} n'est pas mentionné (critères d'acceptation)`);
    }
  }
  if (!text.includes(`.agent-runs/${state.id}/`)) errors.push(`lien vers le run absent : « Run : \`.agent-runs/${state.id}/\` »`);

  const max = conventions.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
  const changed = changedLines(dirname(claudeDir), state.baseBranch || team.baseBranch || 'main', state.branch || 'HEAD');
  if (changed !== null && changed > max) {
    warnings.push(`${changed} lignes modifiées (> ${max}) : PR difficile à relire — justifie la taille dans le résumé ou découpe le run`);
  }

  if (!errors.length) writeFileSync(join(runDir, 'pr-body.md'), `${lines.slice(first + 1).join('\n').replace(/^\n+/, '')}`);
  return { errors, warnings, title };
}

function main(argv) {
  const runDir = argv[2];
  if (!runDir) {
    console.error('Usage : node check-pr.mjs .agent-runs/<id>');
    return 1;
  }
  let result;
  try {
    result = checkPr({ runDir: resolve(runDir) });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 1;
  }
  for (const w of result.warnings) console.warn(`avertissement : ${w}`);
  for (const e of result.errors) console.error(`erreur : ${e}`);
  if (result.errors.length) {
    console.error(`pr.md : ${result.errors.length} erreur(s)`);
    return 1;
  }
  console.log(`pr.md conforme. Titre : ${result.title}\nCorps : ${join(runDir, 'pr-body.md')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
