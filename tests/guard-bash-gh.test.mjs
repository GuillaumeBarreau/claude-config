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

// --- Contournements de la garde gh (préfixes, sous-commandes, chemin, PowerShell) ---

test('guard-bash gh : la fusion est refusée quelle que soit la forme de la commande', () => {
  for (const cmd of [
    '(gh pr merge 1)', 'gh.exe pr merge 1', 'GH.EXE pr merge 1', '& gh pr merge 1', '&gh pr merge 1',
    'env gh pr merge 1', 'env GH_TOKEN=x gh pr merge 1', 'command gh pr merge 1', 'exec gh pr merge 1',
    'sudo gh pr merge 1', '{ gh pr merge 1; }', 'echo $(gh pr merge 1)', 'echo `gh pr merge 1`',
    '/usr/bin/gh pr merge 1', '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 1', "& 'gh.exe' pr merge 1",
    'C:\\tools\\gh.cmd pr merge 1', 'glab.exe mr merge 4', '(glab mr merge 4)',
    'gh api -X PUT repos/o/r/pulls/1/merge', 'gh api --method=PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash',
    'gh api repos/o/r/pulls/1/merge -f merge_method=squash',
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    'gh api graphql -f query=mutation{enablePullRequestAutoMerge(input:{pullRequestId:"x"}){clientMutationId}}',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
});

test('guard-bash gh : toute écriture hors liste de lecture demande un accord', () => {
  for (const cmd of [
    'gh workflow run deploy.yml', 'gh secret set TOKEN', 'gh secret delete TOKEN', 'gh variable set X',
    'gh issue create --title x', 'gh issue delete 4', 'gh issue reopen 4', 'gh pr reopen 3', 'gh label delete bug',
    'gh repo edit --visibility public', 'gh release edit v1', 'gh browse', 'gh pr checkout 3',
    'gh.exe workflow run deploy.yml', '(gh secret set TOKEN)', 'env gh issue create', 'echo $(gh label delete bug)',
    'gh extension install x/y', 'gh auth logout', 'gh run download 3',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('guard-bash gh : lectures toujours libres, y compris sous une forme normalisée', () => {
  for (const cmd of [
    'gh pr view 1', 'gh run list', 'gh run view 2 --log-failed', 'gh api repos/o/r/pulls', 'gh run watch 2',
    'gh pr checks 3', 'gh pr checks 3 --watch', 'gh pr diff 3', 'gh pr status', 'gh pr list --state open',
    'gh issue view 4', 'gh issue list', 'gh repo view', 'gh release list', 'gh release view v1',
    'gh workflow list', 'gh workflow view ci.yml', 'gh label list', 'gh secret list', 'gh status',
    'gh --version', 'gh help', 'gh auth status', 'gh search prs is:open', 'gh -R o/r pr view 1',
    'gh api repos/o/r/pulls/1/merge', 'gh.exe pr view 1', '(gh run list)', 'echo $(gh pr view 1 --json url)',
    'git commit -m "feat(gh): ajoute la garde"',
  ]) {
    assert.equal(decide(cmd), null, cmd);
  }
});

test('guard-bash : la normalisation s\'applique aussi à git', () => {
  assert.equal(decide('git.exe push origin main'), 'deny');
  assert.equal(decide('(git push origin main)'), 'deny');
  assert.equal(decide('& git.exe push origin team/x'), 'ask');
  assert.equal(decide('env GIT_TRACE=1 git push --no-verify'), 'deny');
  assert.equal(decide('echo $(git push origin team/x)'), 'ask');
});
