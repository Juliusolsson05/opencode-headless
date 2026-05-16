import { EventEmitter } from 'events'

import type {
  CommittedCompactBoundaryEvent,
  CommittedEntryEvent,
  CommittedEvent,
  CommittedTurnEvent,
} from './types.js'

export type CommittedChannelEvents = {
  event: [CommittedEvent]
  entry: [CommittedEntryEvent]
  turn_committed: [CommittedTurnEvent]
  compact_boundary: [CommittedCompactBoundaryEvent]
  history_error: [Error]
}

export interface CommittedChannel {
  on<K extends keyof CommittedChannelEvents>(
    event: K,
    listener: (...args: CommittedChannelEvents[K]) => void,
  ): this
  off<K extends keyof CommittedChannelEvents>(
    event: K,
    listener: (...args: CommittedChannelEvents[K]) => void,
  ): this
  emit<K extends keyof CommittedChannelEvents>(
    event: K,
    ...args: CommittedChannelEvents[K]
  ): boolean
}

export class CommittedChannel extends EventEmitter {
  publishMessage(sessionID: string, message: unknown): void {
    const ts = Date.now()
    const entry: CommittedEntryEvent = { type: 'entry', sessionID, message, ts }
    this.emit('entry', entry)
    this.emit('event', entry)

    const role = getString(message, ['role', 'message.role', 'info.role'])
    const text = extractText(message)
    const turnId =
      getString(message, ['id', 'messageID', 'message.id', 'info.id']) ??
      `${sessionID}:${ts}`

    if (role === 'user' || role === 'assistant') {
      const turn: CommittedTurnEvent = {
        type: 'turn_committed',
        sessionID,
        turnId,
        role,
        text,
        message,
        ts,
      }
      this.emit('turn_committed', turn)
      this.emit('event', turn)
    }

    const kind = getString(message, ['type', 'part.type'])
    if (kind === 'compact' || kind === 'compaction' || kind === 'summary') {
      const boundary: CommittedCompactBoundaryEvent = {
        type: 'compact_boundary',
        sessionID,
        message,
        ts,
      }
      this.emit('compact_boundary', boundary)
      this.emit('event', boundary)
    }
  }

  publishError(err: Error): void {
    this.emit('history_error', err)
  }
}

function getString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    let cur: unknown = value
    for (const key of path.split('.')) {
      if (!cur || typeof cur !== 'object' || !(key in cur)) {
        cur = undefined
        break
      }
      cur = (cur as Record<string, unknown>)[key]
    }
    if (typeof cur === 'string' && cur) return cur
  }
  return undefined
}

function extractText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const obj = value as Record<string, unknown>
  const direct = obj.text ?? obj.content ?? obj.summary
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct)) return direct.map(extractText).filter(Boolean).join('\n')
  const parts = obj.parts ?? obj.contentParts ?? obj.message
  if (Array.isArray(parts)) return parts.map(extractText).filter(Boolean).join('\n')
  if (parts && typeof parts === 'object') return extractText(parts)
  const state = obj.state
  if (state && typeof state === 'object') {
    const stateObj = state as Record<string, unknown>
    const output = stateObj.output
    if (typeof output === 'string') return output
    if (output !== undefined && output !== null) return JSON.stringify(output)
  }
  return ''
}
