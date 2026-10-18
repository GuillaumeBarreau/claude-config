// Transforme un titre en identifiant d'URL : minuscules, sans accents, mots séparés
// par des tirets.

export function slugify(text) {
  if (typeof text !== 'string') throw new TypeError('slugify attend une chaîne');
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Le premier mot sert de racine.
  const [first, ...rest] = words;
  return [first.trim(), ...rest].join('-');
}
