# Performance

`mise run perf` runs the probes in `test/perf/suites`. Each one is something a person or an agent waits for: opening a Deck, a keystroke in the roster, starting or waking a session in each harness, a message reaching its recipient. Every probe types into a real terminal (a tmux pane at a shell prompt) and times the screen through a control-mode client, from the key going in to the last output before the screen went still. Each probe takes several samples, writes `test/perf/results/<date>-<sha>.json` with an HTML report beside it, and prints a table and the slowest probes.

- `--only deck,start.claude` narrows the run; `--list` shows every probe and what it measures
- `--against main` builds main in a scratch worktree and interleaves its samples with this checkout's, so a change's cost comes out of one run on one machine; `--baseline FILE` compares with an earlier run instead
- `SWB_TRACE=FILE` makes every swb process and line append marks and spans (`@swb/shared/trace`) to FILE. The runner sets it, and its reports show what filled each probe. Add a span where a probe's time goes unexplained
