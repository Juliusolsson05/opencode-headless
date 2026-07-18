import { EventEmitter } from 'events'

import type {
  ScreenActivityEvent,
  ScreenCompactionEvent,
  ScreenEvent,
  ScreenFileEvent,
  ScreenPermissionEvent,
  ScreenQuestionEvent,
  ScreenSnapshotEvent,
  ScreenSystemEvent,
} from './types.js'

export type ScreenChannelEvents = {
  event: [ScreenEvent]
  snapshot: [ScreenSnapshotEvent]
  activity: [ScreenActivityEvent]
  permission: [ScreenPermissionEvent]
  question: [ScreenQuestionEvent]
  compaction: [ScreenCompactionEvent]
  file: [ScreenFileEvent]
  system: [ScreenSystemEvent]
}

export interface ScreenChannel {
  on<K extends keyof ScreenChannelEvents>(
    event: K,
    listener: (...args: ScreenChannelEvents[K]) => void,
  ): this
  off<K extends keyof ScreenChannelEvents>(
    event: K,
    listener: (...args: ScreenChannelEvents[K]) => void,
  ): this
  emit<K extends keyof ScreenChannelEvents>(
    event: K,
    ...args: ScreenChannelEvents[K]
  ): boolean
}

export class ScreenChannel extends EventEmitter {
  // OpenCode has no terminal that we should scrape. We still publish a synthetic
  // screen channel because app code already treats "visual/overlay state" as a
  // separate surface. Permissions, questions, compaction, and activity all feel
  // screen-like to consumers even when they arrive through SSE rather than cells.

  publishSnapshot(params: { plain: string; markdown?: string }): void {
    const ev: ScreenSnapshotEvent = {
      type: 'snapshot',
      plain: params.plain,
      markdown: params.markdown ?? params.plain,
      ts: Date.now(),
    }
    this.emit('snapshot', ev)
    this.emit('event', ev)
  }

  publishActivity(params: { active: boolean; status: string | null }): void {
    const ev: ScreenActivityEvent = {
      type: 'activity',
      active: params.active,
      status: params.status,
      ts: Date.now(),
    }
    this.emit('activity', ev)
    this.emit('event', ev)
  }

  publishPermission(state: ScreenPermissionEvent['state']): void {
    const ev: ScreenPermissionEvent = { type: 'permission', state, ts: Date.now() }
    this.emit('permission', ev)
    this.emit('event', ev)
  }

  publishQuestion(state: ScreenQuestionEvent['state']): void {
    const ev: ScreenQuestionEvent = { type: 'question', state, ts: Date.now() }
    this.emit('question', ev)
    this.emit('event', ev)
  }

  publishCompaction(state: ScreenCompactionEvent['state']): void {
    const ev: ScreenCompactionEvent = { type: 'compaction', state, ts: Date.now() }
    this.emit('compaction', ev)
    this.emit('event', ev)
  }

  publishFile(params: Omit<ScreenFileEvent, 'type' | 'ts'>): void {
    const ev: ScreenFileEvent = { type: 'file', ...params, ts: Date.now() }
    this.emit('file', ev)
    this.emit('event', ev)
  }

  publishSystem(params: Omit<ScreenSystemEvent, 'type' | 'ts'>): void {
    const ev: ScreenSystemEvent = { type: 'system', ...params, ts: Date.now() }
    this.emit('system', ev)
    this.emit('event', ev)
  }
}
