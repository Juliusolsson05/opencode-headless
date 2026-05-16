import { EventEmitter } from 'events'

export type SseMessage = {
  event?: string
  id?: string
  data: string
}

export type SseClientOptions = {
  url: string
  headers?: Record<string, string>
  fetch?: typeof fetch
  retryMs?: number
}

export type SseClientEvents = {
  message: [SseMessage]
  open: []
  close: []
  error: [Error]
}

export interface SseClient {
  on<K extends keyof SseClientEvents>(
    event: K,
    listener: (...args: SseClientEvents[K]) => void,
  ): this
  off<K extends keyof SseClientEvents>(
    event: K,
    listener: (...args: SseClientEvents[K]) => void,
  ): this
  emit<K extends keyof SseClientEvents>(
    event: K,
    ...args: SseClientEvents[K]
  ): boolean
}

export class SseClient extends EventEmitter {
  private readonly opts: SseClientOptions
  private abortController: AbortController | null = null
  private running = false

  constructor(opts: SseClientOptions) {
    super()
    this.opts = opts
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
  }

  private async loop(): Promise<void> {
    const fetchImpl = this.opts.fetch ?? fetch
    while (this.running) {
      this.abortController = new AbortController()
      try {
        const res = await fetchImpl(this.opts.url, {
          headers: {
            Accept: 'text/event-stream',
            ...this.opts.headers,
          },
          signal: this.abortController.signal,
        })
        if (!res.ok) throw new Error(`SSE ${res.status} ${res.statusText}`)
        if (!res.body) throw new Error('SSE response did not include a body')
        this.emit('open')
        await this.readBody(res.body)
        this.emit('close')
      } catch (err) {
        if (!this.running) return
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
      }

      if (!this.running) return
      await delay(this.opts.retryMs ?? 1_000)
    }
  }

  private async readBody(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (this.running) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = findBoundary(buffer)
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(buffer[boundary] === '\r' ? boundary + 4 : boundary + 2)
        const msg = parseSseMessage(raw)
        if (msg) this.emit('message', msg)
        boundary = findBoundary(buffer)
      }
    }
  }
}

function parseSseMessage(raw: string): SseMessage | null {
  let event: string | undefined
  let id: string | undefined
  const data: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const idx = line.indexOf(':')
    const field = idx >= 0 ? line.slice(0, idx) : line
    const value = idx >= 0 ? line.slice(idx + 1).replace(/^ /, '') : ''
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }

  if (!event && !id && data.length === 0) return null
  return { event, id, data: data.join('\n') }
}

function findBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf < 0) return crlf
  if (crlf < 0) return lf
  return Math.min(lf, crlf)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
