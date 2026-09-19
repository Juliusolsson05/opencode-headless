# Permission and question subjects on OpenCode 1.18.30: plan

**Issue:** Juliusolsson05/agent-code#878 (bug, release blocker: OpenCode is now
bundled, so this is on the default path).
**Branch:** `fix/permission-question-subject` from `main` @ `4f2ef5d`.

## Problem (from recordings, not assumed)

On 1.18.30 the permission modal shows no subject, so the user approves
`bash: ls -1` blind, and the question modal shows no question. Two separate
parsers read these payloads, and both drifted:
- the dispatcher walked `['title','tool','action','permission.action']` first
  non-null, so the now-object `tool` stopped it;
- `permissionRequestFromEvent` walked `['title','tool','action']` and
  matched nothing.

The question text moved to `questions[].question`.

## Change

- One shared parser, `src/permissions/subject.ts` (`permissionSubject`,
  `questionText`, `permissionRequestFromEvent`), used by BOTH the dispatcher
  and OpencodeHeadless.
- The 1.18.30 shape comes first. The old keys stay as string-only fallbacks.

## Test (fail-first, real recordings)

`src/permissions/subject.test.ts` replays the recorded 1.18.30 streams
(`testing/fixtures/live-1.18.30`, copied unchanged from
opencode-terminal-headless's Stage 0 probe) through the real `EventDispatcher`
and channels. It asserts the subject `bash: ls -1`, the question text, and the
same subject on the pending request. Before the fix: 3/3 subject assertions
failed with `undefined`.

## Out of scope

- A cross-package shared parser with opencode-terminal-headless's
  `LiveStateProjector`. That package already parses the shape correctly, and
  sharing would need a third package for two small functions.
