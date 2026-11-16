# End-to-end tests

`mise run e2e` parallelizes test files and runs latency tests separately. Use `SWB_E2E_JOBS` to override local concurrency. CI runs serial tests within parallel shards; reproduce one with `SWB_E2E_SHARD=2/6 mise run e2e`.

Some scenarios install pi-sessions and pi-wt from `node_modules`, at the versions bun.lock pins; point `SWB_E2E_PI_SESSIONS` or `SWB_E2E_PI_WT` at a checkout to test another. Every scenario runs pi, Claude Code, and Codex from `node_modules`, at the exact versions package.json pins, never the host's own installs, so every machine and CI test the same harnesses; `SWB_E2E_PI_CLI` points pi at a checkout instead. Claude Code and Codex run against fake model servers in `test/e2e/fakes`, which log every request they answer.

pi-ai's faux provider, registered by a scenario extension, scripts turns offline at zero token cost.
