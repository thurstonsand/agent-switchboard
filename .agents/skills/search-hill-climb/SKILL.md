---
name: search-hill-climb
description: "Improve session_search's ranking against this machine's own recorded searches: run the search eval, read its misses, change the ranker, keep only what scores better, and push the result. Use when asked to tune, hill-climb, or evaluate session_search, or to run the search eval."
---

# Hill-climb session_search

`mise run eval:search` replays every `session_search` this machine's agents made against this checkout's ranker. Each one is labelled by the session the agent acted on next (asked, showed, messaged, updated, or scheduled), and replayed as the index stood when it ran: only the sessions that existed then, only what they had said by then, and recency counted from then. It scores where the picked session lands: top-1, MRR, and how often it lands within the limit the agent asked for.

The replay calls no model and costs nothing but a few seconds. Your own turns are the cost, so keep them few and their output short.

## The data stays here

The eval reads private transcripts. Its results, under `test/eval/results/`, hold real queries, titles, and session ids, and are gitignored.

- Never commit anything from `test/eval/results/`, and never `git add -f` it.
- Never quote a real query, title, snippet, or session id in code, a comment, a test, a commit message, or a pull request. Describe a miss by its shape instead: "a two-word query where only one word matches ranked first", not the words.
- Never write a real example into an e2e test. A test of a ranking change uses made-up sessions and words, the way `test/e2e/eval-search.test.ts` does.
- Before every commit, run `git status --short` and `git diff --cached --stat` and check that nothing under `test/eval/` but source is staged.

## What you may change

- Change the ranker: `packages/cli/src/recall/search.ts` (`rank`, `matches`, and their weights), `query.ts` (how a query becomes FTS5), and the indexing in `sync.ts` and `store.ts`.
- Bump `RECALL_VERSION` in `store.ts` whenever what the index holds changes: its schema, its tokenizer, or what `extract` writes. Each run reuses its index in `test/eval/results/cache/`, and only a new version rebuilds it.
- Never change `test/eval/search.ts` while climbing. It is the ground truth. If an example looks mislabelled, or the replay looks wrong, stop and say so, with the example's shape; don't edit around it.
- Never special-case a query, a word, or a session. A rule has to make sense for a search you haven't seen.
- Add no dependency.

## The loop

1. **Baseline.** On a clean checkout of the branch you start from, run `mise run eval:search -- --note baseline > /tmp/eval.log 2>&1`, then read the log's summary and misses. Every comparison is against this run. Say how many examples there are; with fewer than about 30, say that any change is within noise and stop after one round unless told otherwise.
2. **Read the misses.** Each lists the rank the checkout gives it now, the rank the agent was shown then, the query, the session picked, and what ranked above it. Find a pattern shared by several, not one example.
3. **One hypothesis, one change.** Make the smallest change that tests it, and commit it on a branch named `search-eval/<what>`, its message naming the pattern it targets.
4. **Score it.** `mise run eval:search -- --note '<what it tries>' > /tmp/eval.log 2>&1`, then `mise run eval:compare` for the latest two runs, or `mise run eval:compare -- BASE.json OTHER.json` against the baseline. Read only the summary and the better and worse lists.
5. **Keep or drop.** Keep a change when tune MRR rises and no example loses its top-1. A tie is dropped, unless the change deletes code. Drop it with `git reset --hard HEAD~1`. A change that crashes or that you can't fix in two tries is dropped too.
6. **Simpler wins.** A small gain that adds a page of special cases isn't worth it. Removing code for an equal score is a win. Every few kept changes, try taking one rule back out.
7. **Change course on a plateau.** After three dropped changes in a row, try a different kind of change: query construction instead of weights, indexing instead of scoring.
8. **Stop** after 8 experiments, kept or not, unless told a different number, or sooner when you run out of patterns worth testing.

`mise run eval:search -- history` lists every run, oldest first, with its note.

## The held-out fifth

A fifth of the examples, chosen by a hash of each, are held out: the summary scores them, and their misses never print unless you pass `--holdout`. Don't pass it while climbing, and don't tune toward the holdout score. Look at it once, at the end: if tune MRR rose and holdout MRR fell, the changes fit these examples rather than search, and you should say so.

## Hand back

Before pushing, run `mise run check`, and `mise run e2e` for the recall tests (`test/e2e/recall-*.test.ts`, `test/e2e/eval-search.test.ts`), since the ranker is what `session_search` answers with everywhere. Then push the branch and report, with numbers only and no real queries:

- the baseline's and the final run's top-1, MRR, and listed, tune and holdout, and how many examples
- each kept change, the shape of the misses it fixed, and its effect on tune MRR
- each dropped change, in a line
- the misses still left, by shape, as follow-ups
