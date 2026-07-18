import { describe, expect, it, vi } from 'vitest'

import { SyncClient } from './SyncClient.js'

describe('SyncClient transport contract', () => {
  it('sends directory, authentication, and JSON request fields to the expected endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'session-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = new SyncClient({
      baseUrl: 'http://127.0.0.1:4096',
      cwd: '/workspace',
      password: 'secret',
      fetch,
    })

    await expect(client.createSession({ title: 'test' })).resolves.toEqual({ id: 'session-1' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:4096/session')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ title: 'test' }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-opencode-directory': '/workspace',
        Authorization: 'Basic ' + Buffer.from('opencode:secret').toString('base64'),
      },
    })
  })

  it('surfaces status and response text for a rejected request', async () => {
    const client = new SyncClient({
      baseUrl: 'http://127.0.0.1:4096',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('permission denied', { status: 403, statusText: 'Forbidden' }),
      ),
    })

    await expect(client.getSession('unsafe/id')).rejects.toThrow(
      'OpenCode HTTP 403 Forbidden: permission denied',
    )
  })
})
