// What a permission or question event is ABOUT. This is the one parser that
// both consumers share: the dispatcher (the modal the user sees) and
// OpencodeHeadless (the pending request that answers the prompt).
//
// WHY one parser (agent-code#878): each path read the subject its own way,
// and neither matched the payload OpenCode actually sends. That shape is
// present since at least 1.14 (vendored source) and recorded on 1.18.30:
//   - `permission.asked`:
//     `{ id, sessionID, permission: "bash", patterns: ["ls -1"], metadata: { command }, always, tool: { messageID, callID } }`
//   - `question.asked`:
//     `{ id, sessionID, questions: [{ question, header, options }], tool }`
// The dispatcher walked `['title','tool','action',…]` first-non-null. `tool`
// is an OBJECT, so the walk stopped there and rejected it. The pending-request
// builder only accepted strings, but it had no key that exists in this shape.
// Both produced an undefined subject, and users approved `bash: ls -1` blind.
//
// Source of truth for the new shape: the recorded 1.18.30 bus in
// testing/fixtures/live-1.18.30 (see its README). It is the same shape
// opencode-terminal-headless's LiveStateProjector already parses. The older
// keys stay as fallbacks, each read ONLY when it is a string, so a server
// that still sends a string `title` keeps working and an object can never
// shadow a later key again.

import type { OpenCodePermissionRequest } from './PermissionService.js'

type Payload = Record<string, unknown>

function asRecord(value: unknown): Payload | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : undefined
}

function stringAt(payload: Payload, path: string): string | undefined {
  let cursor: unknown = payload
  for (const key of path.split('.')) {
    const record = asRecord(cursor)
    if (!record) return undefined
    cursor = record[key]
  }
  return typeof cursor === 'string' && cursor ? cursor : undefined
}

/** The first key whose value is a non-empty STRING. This deliberately differs
 * from a first-non-null lookup: an object at an earlier key (the 1.18.30
 * `tool`) must not hide a string at a later one. */
function firstString(payload: Payload, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = stringAt(payload, path)
    if (value) return value
  }
  return undefined
}

/** Bus events arrive as `{ type, properties }`. Some call sites hand over the
 * properties object directly. */
export function eventPayload(event: unknown): Payload {
  const record = asRecord(event) ?? {}
  return asRecord(record.properties) ?? record
}

/** What the permission is for, e.g. `bash: ls -1` or `edit: src/a.ts`.
 * Falls back to the legacy string title for older servers, or undefined if
 * neither exists. */
export function permissionSubject(payload: unknown): string | undefined {
  const record = asRecord(payload) ?? {}
  const permission = typeof record.permission === 'string' ? record.permission : undefined
  if (permission) {
    // For shell commands, show the WHOLE command, as OpenCode's own
    // permission UI does (`$ ${metadata.command}`). `patterns` holds only the
    // command nodes OpenCode collects: it skips cd/pushd and declarations
    // like `export`. A subject built from it turned
    // `export NODE_OPTIONS=--require=/tmp/x.js && git status` into
    // `bash: git status`, which is the very blind approval this parser exists
    // to prevent (#14 review).
    const command = stringAt(record, 'metadata.command')
    if (permission === 'bash' && command) return `bash: ${command}`
    const patterns = Array.isArray(record.patterns)
      ? record.patterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0)
      : []
    // `["*"]` is how MCP, todowrite and lsp asks say "this tool, no narrower
    // scope". Rendered as `github_create_issue: *`, it read like a request
    // for everything, so the tool name alone is the honest subject.
    const meaningful = patterns.length === 1 && patterns[0] === '*' ? [] : patterns
    return meaningful.length > 0 ? `${permission}: ${meaningful.join(', ')}` : permission
  }
  return firstString(record, ['title', 'action', 'permission.action', 'tool'])
}

/** The question text. On 1.18.30 it lives in `questions[].question`; when
 * several questions come in one prompt, each gets its own line. Older servers
 * put a flat `text`, `question` or `prompt` string on the payload. */
export function questionText(payload: unknown): string | undefined {
  const record = asRecord(payload) ?? {}
  if (Array.isArray(record.questions)) {
    const texts = record.questions
      .map(entry => asRecord(entry)?.question)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
    if (texts.length > 0) return texts.join('\n')
  }
  return firstString(record, ['text', 'question', 'prompt'])
}

/** The request OpencodeHeadless keeps until the permission is answered. */
export function permissionRequestFromEvent(event: unknown): OpenCodePermissionRequest | null {
  const payload = eventPayload(event)
  const requestID = firstString(payload, ['requestID', 'permissionID', 'id'])
  if (!requestID) return null
  return {
    requestID,
    sessionID: firstString(payload, ['sessionID', 'sessionId']),
    title: permissionSubject(payload),
    metadata: payload,
  }
}
