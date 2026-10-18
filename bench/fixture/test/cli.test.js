import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run, SAMPLE_TITLES } from '../src/cli.js';

const capture = (args) => {
  const lines = [];
  const code = run(args, (line) => lines.push(line));
  return { code, lines };
};

test("list affiche un identifiant par titre d'exemple", () => {
  const { code, lines } = capture(['list']);
  assert.equal(code, 0);
  assert.equal(lines.length, SAMPLE_TITLES.length);
  assert.equal(lines[0], 'bonjour-le-monde\tBonjour le monde');
});

test('un titre en argument donne son identifiant', () => {
  assert.deepEqual(capture(['Node.js', 'et', 'les', 'tests']).lines, ['node-js-et-les-tests']);
});

test('sans argument : usage et code 1', () => {
  assert.equal(capture([]).code, 1);
});
