export type SyncClientOptions = {
  baseUrl: string
  cwd?: string
  password?: string
  fetch?: typeof fetch
}

export type PromptOptions = {
  sessionID: string
  prompt: string
  agent?: string
  model?: string
  providerID?: string
  mode?: string
  parts?: unknown[]
  async?: boolean
}

export type PermissionReply = 'once' | 'always' | 'reject'

export class SyncClient {
  private readonly baseUrl: URL
  private readonly fetchImpl: typeof fetch
  private readonly cwd?: string
  private readonly password?: string

  constructor(opts: SyncClientOptions) {
    this.baseUrl = new URL(opts.baseUrl)
    this.fetchImpl = opts.fetch ?? fetch
    this.cwd = opts.cwd
    this.password = opts.password
  }

  eventUrl(): string {
    return new URL('/event', this.baseUrl).toString()
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      ...extra,
    }
    if (this.cwd) headers['x-opencode-directory'] = this.cwd
    if (this.password) {
      headers.Authorization = `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`
    }
    return headers
  }

  async createSession(input: Record<string, unknown> = {}): Promise<unknown> {
    return await this.request('/session', {
      method: 'POST',
      body: input,
    })
  }

  async getSession(sessionID: string): Promise<unknown> {
    return await this.request(`/session/${encodeURIComponent(sessionID)}`)
  }

  async listSessions(): Promise<unknown> {
    return await this.request('/session')
  }

  async messages(sessionID: string): Promise<unknown[]> {
    const data = await this.request(`/session/${encodeURIComponent(sessionID)}/message`)
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>
      if (Array.isArray(obj.data)) return obj.data
      if (Array.isArray(obj.messages)) return obj.messages
    }
    return []
  }

  async prompt(opts: PromptOptions): Promise<unknown> {
    const body = promptBody(opts)
    const suffix = opts.async === false ? 'prompt' : 'prompt_async'
    return await this.request(`/session/${encodeURIComponent(opts.sessionID)}/${suffix}`, {
      method: 'POST',
      body,
    })
  }

  async command(sessionID: string, command: string): Promise<unknown> {
    return await this.request(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: 'POST',
      body: { command },
    })
  }

  async abort(sessionID: string): Promise<unknown> {
    return await this.request(`/session/${encodeURIComponent(sessionID)}/abort`, {
      method: 'POST',
      body: {},
    })
  }

  async replyPermission(
    requestID: string,
    reply: PermissionReply,
    message?: string,
  ): Promise<unknown> {
    return await this.request(`/permission/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: message ? { reply, message } : { reply },
    })
  }

  async syncHistory(input: Record<string, unknown>): Promise<unknown> {
    return await this.request('/sync/history', {
      method: 'POST',
      body: input,
    })
  }

  async disposeInstance(): Promise<unknown> {
    return await this.request('/instance', { method: 'DELETE' })
  }

  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl)
    const headers = this.headers({
      Accept: 'application/json',
    })
    const reqInit: RequestInit = {
      method: init.method ?? 'GET',
      headers,
    }
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      reqInit.body = JSON.stringify(init.body)
    }

    const res = await this.fetchImpl(url, reqInit)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`OpenCode HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
    }
    if (res.status === 204) return undefined
    const text = await res.text()
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

function promptBody(opts: PromptOptions): Record<string, unknown> {
  // WHY this function accepts multiple equivalent field names:
  // OpenCode has v1 and v2 generated clients in flight, and the research found
  // endpoint stability but some body-shape uncertainty. The wrapper should not
  // force every caller through a brittle exact SDK type until we pin an
  // OpenCode version. Sending the conventional `parts` array plus the friendly
  // `prompt` string keeps this compatible with the known prompt endpoints and
  // easy to adapt in one place if the wire contract tightens.
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    parts: opts.parts ?? [{ type: 'text', text: opts.prompt }],
  }
  if (opts.agent) body.agent = opts.agent
  if (opts.model) body.model = opts.model
  if (opts.providerID) body.providerID = opts.providerID
  if (opts.mode) body.mode = opts.mode
  return body
}
