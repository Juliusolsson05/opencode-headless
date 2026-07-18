import { EventEmitter } from 'events'

import { SyncClient, type PermissionReply } from '../transport/SyncClient.js'

export type OpenCodePermissionRequest = {
  requestID: string
  sessionID?: string
  title?: string
  metadata?: unknown
}

export type PermissionServiceEvents = {
  asked: [OpenCodePermissionRequest]
  replied: [{ requestID: string; reply: PermissionReply }]
  error: [Error]
}

export interface PermissionService {
  on<K extends keyof PermissionServiceEvents>(
    event: K,
    listener: (...args: PermissionServiceEvents[K]) => void,
  ): this
  off<K extends keyof PermissionServiceEvents>(
    event: K,
    listener: (...args: PermissionServiceEvents[K]) => void,
  ): this
  emit<K extends keyof PermissionServiceEvents>(
    event: K,
    ...args: PermissionServiceEvents[K]
  ): boolean
}

export class PermissionService extends EventEmitter {
  private readonly client: SyncClient
  private readonly pending = new Map<string, OpenCodePermissionRequest>()

  constructor(client: SyncClient) {
    super()
    this.client = client
  }

  getPending(): OpenCodePermissionRequest[] {
    return [...this.pending.values()]
  }

  remember(req: OpenCodePermissionRequest): void {
    this.pending.set(req.requestID, req)
    this.emit('asked', req)
  }

  async reply(requestID: string, reply: PermissionReply, message?: string): Promise<void> {
    // WHY the request is removed only after the POST succeeds:
    // multiple headless subscribers can observe the same permission event, and
    // OpenCode treats the server-side reply as the authority. If we dropped the
    // local pending state first, a transient network failure would leave callers
    // thinking the permission had been answered when OpenCode is still waiting.
    await this.client.replyPermission(requestID, reply, message)
    this.pending.delete(requestID)
    this.emit('replied', { requestID, reply })
  }

  async approveOnce(requestID: string, message?: string): Promise<void> {
    await this.reply(requestID, 'once', message)
  }

  async approveAlways(requestID: string, message?: string): Promise<void> {
    await this.reply(requestID, 'always', message)
  }

  async reject(requestID: string, message?: string): Promise<void> {
    await this.reply(requestID, 'reject', message)
  }
}
