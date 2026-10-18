import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_ROOT = join(REPO_DIR, 'template');
export const TEMPLATE_CLAUDE = join(TEMPLATE_ROOT, '.claude');

export const tempDir = (prefix = 'claude-config-') => mkdtempSync(join(tmpdir(), prefix));

/** Copie du template dans un dossier temporaire, pour le casser sans risque. */
export function templateCopy() {
  const root = tempDir();
  cpSync(TEMPLATE_CLAUDE, join(root, '.claude'), { recursive: true });
  return root;
}

export function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
