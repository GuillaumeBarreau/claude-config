#!/usr/bin/env node
// Rapport de triage local d'une revue de PR : petit serveur HTTP sur 127.0.0.1, avec un
// jeton aléatoire dans l'URL. Personnel : rien n'est partagé ni envoyé ailleurs.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/serve.mjs .agent-reviews/pr-<n> [--port <n>]
//
// Routes (toutes exigent ?t=<jeton>) :
//   GET  /                    la page de triage (../report/index.html, servie telle quelle)
//   GET  /api/review          review.json
//   POST /api/findings/<id>   corps JSON { decision, rating, label, comment, note } →
//                             applyDecision (decisions.mjs) puis écriture de review.json
// Refus : sans jeton ou hors boucle locale (403), corps de plus de 64 Ko (413).
// AUCUNE route de publication : ce serveur ne peut pas écrire sur GitHub (publish.mjs
// le fait, après accord explicite).
// Sortie : le serveur tourne jusqu'à Ctrl+C ; 2 erreur d'usage ou review.json illisible.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeJson } from '../../team/scripts/gh.mjs';
import { applyDecision } from './decisions.mjs';
import { loadReview } from './store.mjs';

export const MAX_BODY_BYTES = 64 * 1024;
const HOST = '127.0.0.1';
const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'report', 'index.html');
const LOOPBACK = ['127.0.0.1', '::ffff:127.0.0.1'];
const SECURITY = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

const sameToken = (given, token) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Corps de la requête, borné : au-delà de la limite, { tooLarge: true }. */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return { tooLarge: true };
    chunks.push(buf);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Gestionnaire HTTP (req, res) testable sans ouvrir de port.
 * @param reviewDir dossier de la revue ; token jeton attendu dans ?t= ; now horloge.
 */
export function createHandler({ reviewDir, token, now = () => new Date(), page = PAGE }) {
  if (!token) throw new Error('jeton obligatoire');
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, ...SECURITY });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  return async (req, res) => {
    try {
      // Boucle locale seulement, y compris par le nom d'hôte (pas de rebond DNS).
      const host = String(req.headers?.host ?? '').replace(/:\d+$/, '');
      if (!LOOPBACK.includes(req.socket?.remoteAddress) || host !== HOST) return send(res, 403, { error: 'accès réservé à 127.0.0.1' });
      const url = new URL(req.url, `http://${HOST}`);
      if (!sameToken(url.searchParams.get('t'), token)) return send(res, 403, { error: 'jeton absent ou invalide' });

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(page, 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/review') {
        const { review, error } = loadReview(reviewDir);
        return error ? send(res, 500, { error }) : send(res, 200, review);
      }
      const match = /^\/api\/findings\/([^/]+)$/.exec(url.pathname);
      if (match) {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST attendu' });
        const body = await readBody(req);
        if (body.tooLarge) return send(res, 413, { error: `corps de plus de ${MAX_BODY_BYTES / 1024} Ko` });
        let patch;
        try {
          patch = JSON.parse(body.text);
        } catch {
          return send(res, 400, { errors: ['corps JSON invalide'] });
        }
        const { review, error } = loadReview(reviewDir);
        if (error) return send(res, 500, { error });
        const out = applyDecision(review, decodeURIComponent(match[1]), patch, now().toISOString());
        if (out.errors.length) return send(res, 400, { errors: out.errors });
        writeJson(join(reviewDir, 'review.json'), out.review);
        return send(res, 200, { finding: out.finding, round: out.review.rounds.at(-1) });
      }
      return send(res, 404, { error: 'route inconnue' });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  };
}

/** Démarre le serveur sur 127.0.0.1 ; renvoie { server, url } une fois à l'écoute. */
export async function serve({ reviewDir, port = 0, token = randomBytes(24).toString('hex') }) {
  const server = createServer(createHandler({ reviewDir, token }));
  await new Promise((ok, ko) => {
    server.once('error', ko);
    server.listen(port, HOST, ok);
  });
  return { server, url: `http://${HOST}:${server.address().port}/?t=${token}` };
}

async function main(argv) {
  const args = argv.slice(2);
  const portAt = args.indexOf('--port');
  const port = portAt > -1 ? Number(args[portAt + 1]) : 0;
  const reviewDir = args.find((a, i) => !a.startsWith('--') && (portAt === -1 || i !== portAt + 1));
  if (!reviewDir || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Usage : node serve.mjs .agent-reviews/pr-<n> [--port <n>]');
    return 2;
  }
  const { error } = loadReview(resolve(reviewDir));
  if (error) {
    console.error(`erreur : ${error}`);
    return 2;
  }
  try {
    const { url } = await serve({ reviewDir: resolve(reviewDir), port });
    console.log(`Rapport de triage : ${url}`);
    console.log('Local et personnel (127.0.0.1). Ctrl+C pour arrêter. Ce serveur ne publie rien sur GitHub.');
    return null;
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => { if (code !== null) process.exit(code); });
}
