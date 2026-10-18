// guard-bash : commandes gh de la boucle CI et des commentaires de PR (lot D).
// Lire reste libre ; écrire sur GitHub (commentaire, revue, relance, appel API
// modifiant) demande l'accord de l'utilisateur.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';

const ctx = { baseBranch: 'main', currentBranch: () => 'team/x' };
const decide = (command) => evaluateCommand(command, ctx)?.decision ?? null;

test('guard-bash gh : lectures libres (runs, journaux, PR, API en GET)', () => {
  for (const cmd of [
    'gh run list --branch team/x --json databaseId,headSha,status,conclusion,workflowName,url --limit 50',
    'gh run view 123 --log-failed',
    'gh run view 123 --json jobs',
    'gh pr view team/x --json number,url',
    'gh pr view 12 --json number,url,state,comments,reviews,headRefOid',
    'gh api repos/{owner}/{repo}/pulls/12/comments --paginate',
    'gh api -X GET repos/o/r/pulls/12/comments',
    'gh api --method GET repos/o/r/issues/12',
    'gh api --method=get repos/o/r/issues/12',
    'gh api repos/o/r/pulls/12/comments --paginate | node script.mjs',
  ]) {
    assert.equal(decide(cmd), null, cmd);
  }
});

test('guard-bash gh : appels API modifiants demandent un accord', () => {
  for (const cmd of [
    'gh api -X POST repos/o/r/issues/12/comments -f body=ok',
    'gh api -XPOST repos/o/r/issues/12/comments',
    'gh api --method PATCH repos/o/r/pulls/12',
    'gh api --method=DELETE repos/o/r/issues/comments/5',
    'gh api repos/o/r/issues/12/comments -f body=merci',
    'gh api repos/o/r/issues/12/comments -F body=@note.md',
    'gh api repos/o/r/issues/12/labels --field labels[]=bug',
    'gh api repos/o/r/issues/12/comments --raw-field body=x',
    'gh api repos/o/r/pulls/12/reviews --input review.json',
    'gh api graphql -f query=mutation{x}',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('guard-bash gh : relance de CI, commentaires et revues demandent un accord', () => {
  for (const cmd of [
    'gh run rerun 123 --failed', 'gh run cancel 123',
    'gh issue comment 4 --body x', 'gh issue edit 4 --add-label bug', 'gh issue close 4',
    'gh pr comment 12 --body "corrigé"', 'gh pr review 12 --approve', 'gh pr edit 12 --title x',
    'gh pr comment 12 -R o/r --body x', 'npm test && gh pr comment 12 --body x',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('guard-bash gh : les règles existantes restent intactes', () => {
  assert.equal(decide('gh pr merge 12'), 'deny');
  assert.equal(decide('gh pr merge --auto --squash 3'), 'deny');
  assert.equal(decide('gh pr create --fill'), 'ask');
  assert.equal(decide('gh pr ready 12'), 'ask');
  assert.equal(decide('git commit -m "x\n\nCo-Authored-By: a <b@c>"'), 'deny');
  // deny l'emporte sur ask dans une même commande.
  assert.equal(decide('gh pr comment 12 --body x && gh pr merge 12'), 'deny');
});
