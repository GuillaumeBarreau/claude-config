#!/usr/bin/env node
// Valide une configuration .claude/ produite par claude-config : celle du dépôt
// (template/) ou celle installée dans un projet. Une config qui ne valide pas ne se
// charge pas comme prévu, souvent sans erreur visible : c'est ce que ce script attrape.
//
// Usage : node validate.mjs [dossier contenant .claude/]   (défaut : template)
// Sortie : 0 sans erreur (les avertissements ne font pas échouer), 1 sinon.
//
// Contrôles inspirés de validate_agent_system.py (claude-agent-framework, licence MIT).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
const KNOWN_TOOLS = [
  'Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'PowerShell', 'Read',
  'Skill', 'WebFetch', 'WebSearch', 'Write',
];
const REQUIRED_AGENT_KEYS = ['name', 'description', 'tools', 'model', 'effort'];
const TRUTHY = ['true', 'yes', 'on', '1'];
// Le corps d'un agent devient son prompt système, payé à chaque lancement.
const MAX_AGENT_LINES = 100;
const MAX_SKILL_LINES = 500;

/**
 * Frontmatter YAML restreint : `clé: valeur` au premier niveau et listes `- élément`
 * sous une clé vide. Les blocs imbriqués (hooks) sont repérés mais pas interprétés.
 * Renvoie { data, body } ou null sans bloc de frontmatter terminé.
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const data = {};
  let current = null;
  let block = false; // valeur `|` ou `>` : les lignes indentées suivantes forment le texte
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return { data, body: lines.slice(i + 1).join('\n') };
    if (!line.trim() || (!block && line.trim().startsWith('#'))) continue;
    if (/^\s/.test(line)) {
      if (!current) continue;
      if (block) {
        data[current] = `${data[current]} ${line.trim()}`.trim();
        continue;
      }
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item && Array.isArray(data[current])) data[current].push(unquote(item[1]));
      continue;
    }
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    current = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    block = /^[|>][+-]?$/.test(value);
    if (block) data[current] = '';
    else if (value === '') data[current] = [];
    else if (/^\[.*\]$/.test(value)) data[current] = value.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean);
    else data[current] = unquote(value);
  }
  return null;
}

function unquote(v) {
  return v.length >= 2 && v[0] === v.at(-1) && `"'`.includes(v[0]) ? v.slice(1, -1) : v;
}

export function splitList(value) {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[,\s]+(?![^(]*\))/).map((v) => v.trim()).filter(Boolean);
}

const grantsWildcard = (tool) => tool === '*' || /^[\w-]+\(\s*[*:\s]*\)$/.test(tool) && tool.includes('*');
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []);

function loadSkills(claudeDir, errors) {
  const skills = new Map();
  for (const entry of listDir(join(claudeDir, 'skills'))) {
    if (!entry.isDirectory()) continue;
    const label = `skills/${entry.name}/SKILL.md`;
    const path = join(claudeDir, 'skills', entry.name, 'SKILL.md');
    if (!existsSync(path)) {
      errors.push(`${label} : fichier absent, la skill « ${entry.name} » n'existe pas`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const fm = parseFrontmatter(text);
    skills.set(entry.name, { label, path, text, fm });
  }
  return skills;
}

function checkSkills(skills, managed, errors, warnings) {
  for (const [name, { label, path, text, fm }] of skills) {
    // Fichier propre au projet : signalé, mais ne fait pas échouer la validation.
    const report = managed(label) ? errors : warnings;
    if (!fm) {
      report.push(`${label} : pas de frontmatter — description et contrôles d'invocation absents`);
      continue;
    }
    const { data, body } = fm;
    if (data.name && data.name !== name) {
      report.push(`${label} : name « ${data.name} » ≠ dossier « ${name} » (c'est le dossier que /${name} résout)`);
    }
    if (!data.description) report.push(`${label} : description obligatoire`);
    for (const tool of splitList(data['allowed-tools'])) {
      if (grantsWildcard(tool)) report.push(`${label} : allowed-tools accorde « ${tool} » sans restriction`);
    }
    const nLines = text.split(/\r?\n/).length;
    if (nLines > MAX_SKILL_LINES) warnings.push(`${label} : ${nLines} lignes (> ${MAX_SKILL_LINES})`);

    // Liens relatifs vers les fichiers de la skill : un lien cassé est une étape que
    // le modèle ne pourra pas lire. Les exemples en bloc de code ne comptent pas.
    const prose = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const [, target] of prose.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(dirname(path), target))) {
        report.push(`${label} : lien vers « ${target} » introuvable`);
      }
    }
  }
}

function checkAgents(claudeDir, skills, managed, errors, warnings) {
  const agents = new Set();
  for (const entry of listDir(join(claudeDir, 'agents'))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    const label = `agents/${entry.name}`;
    agents.add(name);
    const report = managed(label) ? errors : warnings;
    const fm = parseFrontmatter(readFileSync(join(claudeDir, 'agents', entry.name), 'utf8'));
    if (!fm) {
      report.push(`${label} : pas de frontmatter lisible`);
      continue;
    }
    const { data, body } = fm;
    // Claude Code n'exige que name et description. Nos agents déclarent aussi outils,
    // modèle et effort ; un agent propre au projet n'y est pas tenu.
    const required = managed(label) ? REQUIRED_AGENT_KEYS : ['name', 'description'];
    for (const key of required) {
      if (data[key] === undefined || data[key] === '' || (Array.isArray(data[key]) && !data[key].length)) {
        report.push(`${label} : clé obligatoire « ${key} » absente ou vide`);
      }
    }
    if (data.name && data.name !== name) report.push(`${label} : name « ${data.name} » ≠ nom du fichier`);
    if (data.model && !MODELS.includes(data.model) && !/^claude-/.test(data.model)) {
      report.push(`${label} : model « ${data.model} » inconnu (${MODELS.join(', ')} ou identifiant claude-*)`);
    }
    if (data.effort && !EFFORTS.includes(data.effort)) {
      report.push(`${label} : effort « ${data.effort} » inconnu (${EFFORTS.join(', ')})`);
    }
    if (data.color && !COLORS.includes(data.color)) warnings.push(`${label} : color « ${data.color} » inconnue`);

    const tools = splitList(data.tools);
    for (const tool of tools) {
      if (grantsWildcard(tool)) report.push(`${label} : tools « ${tool} » — liste ce dont le rôle a besoin`);
      else if (!KNOWN_TOOLS.includes(tool.replace(/\(.*$/, '')) && !tool.startsWith('mcp__')) {
        warnings.push(`${label} : outil « ${tool} » inconnu du validateur`);
      }
    }
    const denied = splitList(data.disallowedTools);
    for (const tool of tools.filter((t) => denied.includes(t))) {
      warnings.push(`${label} : « ${tool} » est à la fois dans tools et disallowedTools`);
    }

    // Une skill préchargée doit exister et rester préchargeable.
    for (const skill of splitList(data.skills)) {
      const found = skills.get(skill);
      if (!found) {
        report.push(`${label} : skill préchargée « ${skill} » introuvable dans skills/`);
      } else if (TRUTHY.includes(String(found.fm?.data['disable-model-invocation']).toLowerCase())) {
        report.push(`${label} : skill « ${skill} » a disable-model-invocation: true, ce qui empêche son préchargement`);
      }
    }

    const nLines = body.split(/\r?\n/).length;
    if (nLines > MAX_AGENT_LINES) {
      warnings.push(`${label} : corps de ${nLines} lignes (> ${MAX_AGENT_LINES}) — déplace le détail dans une skill`);
    }
  }
  return agents;
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    errors.push(`${label} : JSON invalide — ${err.message}`);
    return null;
  }
}

function checkTeamConfig(claudeDir, agents, errors) {
  const path = join(claudeDir, 'team.json');
  if (!existsSync(path)) {
    errors.push('team.json : absent');
    return;
  }
  const config = readJson(path, 'team.json', errors);
  if (!config) return;
  if (typeof config.initialized !== 'boolean') errors.push('team.json : « initialized » doit être true ou false');
  if (typeof config.baseBranch !== 'string' || !config.baseBranch) errors.push('team.json : « baseBranch » obligatoire');
  for (const key of ['maxAttempts', 'maxClarificationRounds']) {
    if (!Number.isInteger(config[key]) || config[key] < 0) errors.push(`team.json : « ${key} » doit être un entier ≥ 0`);
  }
  for (const [name, enabled] of Object.entries(config.agents ?? {})) {
    if (enabled === true && !agents.has(name)) errors.push(`team.json : agent « ${name} » activé mais agents/${name}.md absent`);
  }
  if (!Array.isArray(config.checks)) {
    errors.push('team.json : « checks » doit être une liste');
    return;
  }
  for (const [i, check] of config.checks.entries()) {
    if (!check?.name || !check?.command || typeof check?.required !== 'boolean') {
      errors.push(`team.json : checks[${i}] doit avoir name, command et required (booléen)`);
    }
  }
}

export function validate(root) {
  const errors = [];
  const warnings = [];
  const claudeDir = join(root, '.claude');
  if (!existsSync(claudeDir)) return { errors: [`${claudeDir} : dossier absent`], warnings };

  // Projet installé : seuls les fichiers du manifeste sont tenus aux règles strictes.
  // Template (pas de manifeste) : tout l'est.
  const manifestPath = join(claudeDir, 'claude-config.manifest.json');
  let managed = () => true;
  if (existsSync(manifestPath)) {
    const files = readJson(manifestPath, 'claude-config.manifest.json', errors)?.files ?? {};
    managed = (label) => label in files;
  }

  const skills = loadSkills(claudeDir, errors);
  checkSkills(skills, managed, errors, warnings);
  const agents = checkAgents(claudeDir, skills, managed, errors, warnings);
  checkTeamConfig(claudeDir, agents, errors);
  const settings = join(claudeDir, 'settings.json');
  if (existsSync(settings)) readJson(settings, 'settings.json', errors);
  return { errors, warnings };
}

function main(argv) {
  const root = resolve(argv[2] ?? 'template');
  const { errors, warnings } = validate(root);
  for (const w of warnings) console.warn(`avertissement : ${w}`);
  for (const e of errors) console.error(`erreur : ${e}`);
  console.log(`${root} : ${errors.length} erreur(s), ${warnings.length} avertissement(s)`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
