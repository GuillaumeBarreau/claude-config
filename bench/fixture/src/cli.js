#!/usr/bin/env node
// Interface en ligne de commande.
//   slug-tool <titre>   affiche l'identifiant du titre
//   slug-tool list      affiche les identifiants des titres d'exemple

import { pathToFileURL } from 'node:url';
import { slugify } from './slugify.js';

export const SAMPLE_TITLES = ['Bonjour le monde', 'Été à Paris', 'Node.js et les tests'];

export function run(args, out = console.log) {
  const [command, ...rest] = args;
  if (!command) {
    out('Usage : slug-tool <titre> | slug-tool list');
    return 1;
  }
  if (command === 'list') {
    for (const title of SAMPLE_TITLES) out(`${slugify(title)}\t${title}`);
    return 0;
  }
  out(slugify([command, ...rest].join(' ')));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
