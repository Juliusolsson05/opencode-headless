# opencode-headless testing harness

This folder is intentionally temporary. It is not production package code and
can disappear once `opencode-headless` has mature automated coverage.

The goal is to exercise the wrapper against a real local `opencode` install and
the user's real provider authentication. That is the only way to validate the
parts this package exists for:

- spawning `opencode serve`
- reusing terminal-authenticated providers
- receiving `/event` SSE data
- mapping live assistant output without duplicate deltas
- refreshing committed history
- observing tool/file-edit behavior in a realistic workspace

Run from the repository root after building the package:

```sh
npm --prefix packages/opencode-headless run build
node packages/opencode-headless/testing/run-agentic-loop.mjs
```

The realistic workspace lives outside this repository:

```text
/Users/juliusolsson/Desktop/Development/testing/opencode-work
```

The harness rewrites that directory on each run.
