import { CommittedChannel } from '../channels/CommittedChannel.js'
import { SyncClient } from '../transport/SyncClient.js'

export class HistoryClient {
  private readonly sync: SyncClient
  private readonly committed: CommittedChannel

  constructor(sync: SyncClient, committed: CommittedChannel) {
    this.sync = sync
    this.committed = committed
  }

  async publishSessionMessages(sessionID: string): Promise<unknown[]> {
    try {
      const messages = await this.sync.messages(sessionID)
      for (const message of messages) this.committed.publishMessage(sessionID, message)
      return messages
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.committed.publishError(error)
      throw error
    }
  }
}
