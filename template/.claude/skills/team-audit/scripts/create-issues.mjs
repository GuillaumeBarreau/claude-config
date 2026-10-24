#!/usr/bin/env node
// Crée des issues GitHub à partir d'un fichier JSON de constats.
// Chaque constat porte { issueTitle, issueBody }. Le label « agent-ready » est ajouté.
// Sortie JSON : { created: [{ title, url }], failed: [{ title, error }] }.
//
// Usage : node create-issues.mjs <fichier.json>
// Code : 0 tout créé, 1 au moins un échec, 2 usage ou prérequis.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Vérifie que gh est authentifié. Lève une erreur sinon. */
export function checkGhAuth() {
  try {
    execFileSync('gh', ['auth', 'status'], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    throw new Error('gh non authentifié : lance « gh auth login » puis réessaie');
  }
}

/** Valide un constat et renvoie { title, body } prêts pour gh issue create. */
export function formatFinding(finding) {
  if (!finding || typeof finding !== 'object') throw new Error('constat invalide : objet attendu');
  const title = finding.issueTitle;
  const body = finding.issueBody;
  if (typeof title !== 'string' || !title.trim()) throw new Error('issueTitle manquant ou vide');
  if (typeof body !== 'string' || !body.trim()) throw new Error('issueBody manquant ou vide');
  return { title: title.trim(), body: body.trim() };
}

/** Crée une issue GitHub avec gh. Renvoie l'URL de l'issue créée. */
export function createIssue(title, body, label) {
  const result = execFileSync('gh', [
    'issue', 'create',
    '--title', title,
    '--body', body,
    '--label', label,
  ], { encoding: 'utf8', stdio: 'pipe' });
  return result.trim();
}

function main(argv) {
  const file = argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage : node create-issues.mjs <fichier.json>');
    return 2;
  }

  let findings;
  try {
    findings = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`${file} : illisible (${err.message})`);
    return 2;
  }

  if (!Array.isArray(findings) || !findings.length) {
    console.error('le fichier doit contenir une liste non vide de constats');
    return 2;
  }

  try {
    checkGhAuth();
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  const created = [];
  const failed = [];

  for (const finding of findings) {
    let formatted;
    try {
      formatted = formatFinding(finding);
    } catch (err) {
      failed.push({ title: finding?.issueTitle ?? '(sans titre)', error: err.message });
      continue;
    }
    try {
      const url = createIssue(formatted.title, formatted.body, 'agent-ready');
      created.push({ title: formatted.title, url });
    } catch (err) {
      failed.push({ title: formatted.title, error: err.message });
    }
  }

  console.log(JSON.stringify({ created, failed }));
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
