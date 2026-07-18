import { describe, expect, it, vi } from 'vitest'

import { PermissionService } from './PermissionService.js'
import { SyncClient } from '../transport/SyncClient.js'

describe('PermissionService', () => {
  it('retains a pending request when the server rejects the reply', async () => {
    const client = new SyncClient({
      baseUrl: 'http://127.0.0.1:4096',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('unavailable', { status: 503, statusText: 'Unavailable' }),
      ),
    })
    const service = new PermissionService(client)
    service.remember({ requestID: 'permission-1', title: 'Run command' })

    await expect(service.approveOnce('permission-1')).rejects.toThrow('OpenCode HTTP 503')
    expect(service.getPending()).toEqual([
      { requestID: 'permission-1', title: 'Run command' },
    ])
  })

  it('removes and emits a pending request only after the server accepts it', async () => {
    const client = new SyncClient({
      baseUrl: 'http://127.0.0.1:4096',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    })
    const service = new PermissionService(client)
    const replied = vi.fn()
    service.on('replied', replied)
    service.remember({ requestID: 'permission-1' })

    await service.reject('permission-1', 'not allowed')

    expect(service.getPending()).toEqual([])
    expect(replied).toHaveBeenCalledWith({ requestID: 'permission-1', reply: 'reject' })
  })
})
