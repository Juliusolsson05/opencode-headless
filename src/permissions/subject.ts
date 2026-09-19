// What a permission or question event is ABOUT. This is the one parser that
// both consumers share: the dispatcher (the modal the user sees) and
// OpencodeHeadless (the pending request that answers the prompt).
//
// WHY one parser (agent-code#878): each path used to read the subject its
// own way, and both drifted when OpenCode 1.18.30 changed the payload.
//   - `permission.asked` is now
//     `{ id, sessionID, permission: "bash", patterns: ["ls -1"], metadata, always, tool: { messageID, callID } }`
//   - `question.asked` is now
//     `{ id, sessionID, questions: [{ question, header, options }], tool }`
// The old readers tried `['title', 'tool', 'action']` through a
// first-non-null lookup. `tool` is now an OBJECT, so the lookup stopped
// there, rejected it as "not a string", and never tried the later keys. The
// modal showed no subject, and users approved `bash: ls -1` blind.
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

/** `bash: ls -1` on 1.18.30 (permission name plus the patterns it covers);
 * the legacy string title on older servers; undefined if neither exists. */
export function permissionSubject(payload: unknown): string | undefined {
  const record = asRecord(payload) ?? {}
  const permission = typeof record.permission === 'string' ? record.permission : undefined
  if (permission) {
    const patterns = Array.isArray(record.patterns)
      ? record.patterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0)
      : []
    return patterns.length > 0 ? `${permission}: ${patterns.join(', ')}` : permission
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
