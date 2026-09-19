# live-1.18.30 fixtures

These are real OpenCode 1.18.30 SSE bus recordings, copied unchanged from
`opencode-terminal-headless/testing/fixtures/live/` (commit `a83130f`, "stamp
the fixtures, floor the coverage, watch for drift"). There they were recorded
by that package's Stage 0 live probe, `scripts/probe-live.mts`, against the
real OpenCode 1.18.30 TUI server.

Recording conditions:
- a throwaway HOME/XDG and project;
- synthetic prompts;
- the free `opencode/big-pickle` model;
- sandbox paths and ports normalised.

The `meta` block inside each file records this, plus a schema hash.

| File | Scenario | What it pins here |
|---|---|---|
| `permission-once.json` | an agent runs `ls -1` and the user allows it once | the 1.18.30 `permission.asked` shape: `permission: "bash"`, `patterns: ["ls -1"]`, and `tool` as an object |
| `question-reject.json` | the agent asks "red or blue?" and the user rejects | the 1.18.30 `question.asked` shape: `questions[].question` |

`src/permissions/subject.test.ts` replays each stream, in its recorded order,
through the real `EventDispatcher` and channels (agent-code#878). Do not edit
these files by hand. If OpenCode changes the bus again, record new ones with
the probe and keep these as the 1.18.30 baseline.
