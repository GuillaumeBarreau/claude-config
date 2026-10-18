import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugify } from '../src/slugify.js';

test('minuscules et tirets', () => {
  assert.equal(slugify('Bonjour le monde'), 'bonjour-le-monde');
});

test('accents et ponctuation retirés', () => {
  assert.equal(slugify('Été à Paris !'), 'ete-a-paris');
});

test("refuse ce qui n'est pas une chaîne", () => {
  assert.throws(() => slugify(42), TypeError);
});
