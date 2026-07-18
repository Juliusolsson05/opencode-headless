import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: spawnMock,
}))

import { SpawnedServer } from './SpawnedServer.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 42
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  })
}

function arrangeChild(): FakeChild {
  const child = new FakeChild()
  spawnMock.mockReturnValue(child)
  return child
}

afterEach(() => {
  vi.useRealTimers()
  spawnMock.mockReset()
})

describe('SpawnedServer process ownership', () => {
  it('uses the child listen line as the readiness source of truth', async () => {
    const child = arrangeChild()
    const server = new SpawnedServer({
      binary: 'opencode-test',
      cwd: '/workspace',
      port: 0,
      pure: true,
    })

    const started = server.start()
    child.stdout.write('starting\nopencode server listening on http://127.0.0.1:43123\n')

    await expect(started).resolves.toMatchObject({
      url: 'http://127.0.0.1:43123',
      child,
    })
    expect(server.pid).toBe(42)
    expect(spawnMock).toHaveBeenCalledWith(
      'opencode-test',
      ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'],
      expect.objectContaining({ cwd: '/workspace' }),
    )
  })

  it('terminates and forgets a child that never becomes ready', async () => {
    vi.useFakeTimers()
    const child = arrangeChild()
    const server = new SpawnedServer({
      binary: 'opencode-test',
      cwd: '/workspace',
      startupTimeoutMs: 25,
    })

    const started = server.start()
    const rejected = expect(started).rejects.toThrow(
      'Timed out waiting for opencode-test serve to report its URL',
    )
    await vi.advanceTimersByTimeAsync(25)

    await rejected
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(server.pid).toBeNull()
    expect(server.serverUrl).toBeNull()
  })

  it('includes stderr when the child exits before readiness', async () => {
    const child = arrangeChild()
    const server = new SpawnedServer({ cwd: '/workspace' })
    const started = server.start()

    child.stderr.write('configuration rejected')
    child.exitCode = 1
    child.emit('exit', 1, null)

    await expect(started).rejects.toThrow(
      'opencode serve exited before readiness: configuration rejected',
    )
    expect(server.pid).toBeNull()
  })

  it('escalates stop when SIGTERM was sent but the child did not exit', async () => {
    vi.useFakeTimers()
    const child = arrangeChild()
    // WHY this fake does not emit exit: ChildProcess.killed becomes true as
    // soon as kill() is called, which previously fooled stop() into believing
    // the process was gone. The regression requires a stubborn live child.
    child.kill.mockImplementation(() => true)
    const server = new SpawnedServer({ cwd: '/workspace' })
    const started = server.start()
    child.stdout.write('opencode server listening on http://127.0.0.1:43123\n')
    await started

    const stopped = server.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    await stopped

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })
})
