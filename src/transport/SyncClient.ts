export type SyncClientOptions = {
  baseUrl: string
  cwd?: string
  password?: string
  fetch?: typeof fetch
}

export type PromptOptions = {
  sessionID: string
  prompt: string
  messageID?: string
  agent?: string
  model?: string
  modelID?: string
  providerID?: string
  mode?: string
  parts?: unknown[]
  async?: boolean
  noReply?: boolean
  tools?: Record<string, boolean>
  format?: unknown
  system?: string
  variant?: string
}

export type PermissionReply = 'once' | 'always' | 'reject'
export type QuestionAnswer = string[]
export type QueryValue = string | number | boolean | undefined | null
export type ModelSelection = {
  providerID?: string
  model?: string
  modelID?: string
}

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

  async getPaths(): Promise<unknown> {
    return await this.request('/path')
  }

  async listProviders(): Promise<unknown> {
    return await this.request('/provider')
  }

  async getProviderAuthMethods(): Promise<unknown> {
    return await this.request('/provider/auth')
  }

  async authorizeProvider(providerID: string, input: unknown): Promise<unknown> {
    return await this.request(`/provider/${encodeURIComponent(providerID)}/oauth/authorize`, {
      method: 'POST',
      body: input,
    })
  }

  async callbackProvider(providerID: string, input: unknown): Promise<unknown> {
    return await this.request(`/provider/${encodeURIComponent(providerID)}/oauth/callback`, {
      method: 'POST',
      body: input,
    })
  }

  async getConfig(): Promise<unknown> {
    return await this.request('/config')
  }

  async updateConfig(input: unknown): Promise<unknown> {
    return await this.request('/config', { method: 'PATCH', body: input })
  }

  async getProviderConfig(): Promise<unknown> {
    return await this.request('/config/providers')
  }

  async listProjects(): Promise<unknown[]> {
    const data = await this.request('/project')
    return Array.isArray(data) ? data : []
  }

  async getCurrentProject(): Promise<unknown> {
    return await this.request('/project/current')
  }

  async initProjectGit(): Promise<unknown> {
    return await this.request('/project/git/init', { method: 'POST', body: {} })
  }

  async updateProject(projectID: string, input: unknown): Promise<unknown> {
    return await this.request(`/project/${encodeURIComponent(projectID)}`, {
      method: 'PATCH',
      body: input,
    })
  }

  async listCommands(): Promise<unknown[]> {
    const data = await this.request('/command')
    return Array.isArray(data) ? data : []
  }

  async listAgents(): Promise<unknown[]> {
    const data = await this.request('/agent')
    return Array.isArray(data) ? data : []
  }

  async listSkills(): Promise<unknown[]> {
    const data = await this.request('/skill')
    return Array.isArray(data) ? data : []
  }

  async getLspStatus(): Promise<unknown[]> {
    const data = await this.request('/lsp')
    return Array.isArray(data) ? data : []
  }

  async getFormatterStatus(): Promise<unknown[]> {
    const data = await this.request('/formatter')
    return Array.isArray(data) ? data : []
  }

  async getVcsInfo(): Promise<unknown> {
    return await this.request('/vcs')
  }

  async getVcsStatus(): Promise<unknown[]> {
    const data = await this.request('/vcs/status')
    return Array.isArray(data) ? data : []
  }

  async getVcsDiff(mode: string): Promise<unknown[]> {
    const data = await this.request('/vcs/diff', { query: { mode } })
    return Array.isArray(data) ? data : []
  }

  async getVcsDiffRaw(): Promise<unknown> {
    return await this.request('/vcs/diff/raw')
  }

  async applyVcsPatch(input: unknown): Promise<unknown> {
    return await this.request('/vcs/apply', { method: 'POST', body: input })
  }

  async findText(pattern: string): Promise<unknown[]> {
    const data = await this.request('/find', { query: { pattern } })
    return Array.isArray(data) ? data : []
  }

  async findFile(query: string, opts: { dirs?: boolean; type?: 'file' | 'directory'; limit?: number } = {}): Promise<string[]> {
    const data = await this.request('/find/file', {
      query: {
        query,
        dirs: opts.dirs === undefined ? undefined : String(opts.dirs),
        type: opts.type,
        limit: opts.limit,
      },
    })
    return Array.isArray(data) ? data.filter((value): value is string => typeof value === 'string') : []
  }

  async findSymbol(query: string): Promise<unknown[]> {
    const data = await this.request('/find/symbol', { query: { query } })
    return Array.isArray(data) ? data : []
  }

  async listFiles(path: string): Promise<unknown[]> {
    const data = await this.request('/file', { query: { path } })
    return Array.isArray(data) ? data : []
  }

  async readFileContent(path: string): Promise<unknown> {
    return await this.request('/file/content', { query: { path } })
  }

  async getFileStatus(): Promise<unknown[]> {
    const data = await this.request('/file/status')
    return Array.isArray(data) ? data : []
  }

  async listPermissions(): Promise<unknown[]> {
    const data = await this.request('/permission')
    return Array.isArray(data) ? data : []
  }

  async listQuestions(): Promise<unknown[]> {
    const data = await this.request('/question')
    return Array.isArray(data) ? data : []
  }

  async getMcpStatus(): Promise<unknown> {
    return await this.request('/mcp')
  }

  async addMcp(name: string, config: unknown): Promise<unknown> {
    return await this.request('/mcp', {
      method: 'POST',
      body: { name, config },
    })
  }

  async connectMcp(name: string): Promise<unknown> {
    return await this.request(`/mcp/${encodeURIComponent(name)}/connect`, { method: 'POST', body: {} })
  }

  async disconnectMcp(name: string): Promise<unknown> {
    return await this.request(`/mcp/${encodeURIComponent(name)}/disconnect`, { method: 'POST', body: {} })
  }

  async startMcpAuth(name: string): Promise<unknown> {
    return await this.request(`/mcp/${encodeURIComponent(name)}/auth`, { method: 'POST', body: {} })
  }

  async callbackMcpAuth(name: string, code: string): Promise<unknown> {
    return await this.request(`/mcp/${encodeURIComponent(name)}/auth/callback`, {
      method: 'POST',
      body: { code },
    })
  }

  async authenticateMcp(name: string): Promise<unknown> {
    return await this.request(`/mcp/${encodeURIComponent(name)}/auth/authenticate`, {
      method: 'POST',
      body: {},
    })
  }

  async removeMcpAuth(name: string): Promise<unknown> {
    return await this.request(`/mcp/${encodeURIComponent(name)}/auth`, { method: 'DELETE' })
  }

  async listPtyShells(): Promise<unknown[]> {
    const data = await this.request('/pty/shells')
    return Array.isArray(data) ? data : []
  }

  async listPtys(): Promise<unknown[]> {
    const data = await this.request('/pty')
    return Array.isArray(data) ? data : []
  }

  async createPty(input: unknown): Promise<unknown> {
    return await this.request('/pty', { method: 'POST', body: input })
  }

  async getPty(ptyID: string): Promise<unknown> {
    return await this.request(`/pty/${encodeURIComponent(ptyID)}`)
  }

  async updatePty(ptyID: string, input: unknown): Promise<unknown> {
    return await this.request(`/pty/${encodeURIComponent(ptyID)}`, { method: 'PUT', body: input })
  }

  async removePty(ptyID: string): Promise<unknown> {
    return await this.request(`/pty/${encodeURIComponent(ptyID)}`, { method: 'DELETE' })
  }

  async createPtyConnectToken(ptyID: string): Promise<unknown> {
    return await this.request(`/pty/${encodeURIComponent(ptyID)}/connect-token`, {
      method: 'POST',
      body: {},
      headers: { 'x-opencode-ticket': '1' },
    })
  }

  async appendTuiPrompt(text: string): Promise<unknown> {
    return await this.request('/tui/append-prompt', { method: 'POST', body: { text } })
  }

  async openTuiHelp(): Promise<unknown> {
    return await this.request('/tui/open-help', { method: 'POST', body: {} })
  }

  async openTuiSessions(): Promise<unknown> {
    return await this.request('/tui/open-sessions', { method: 'POST', body: {} })
  }

  async openTuiThemes(): Promise<unknown> {
    return await this.request('/tui/open-themes', { method: 'POST', body: {} })
  }

  async openTuiModels(): Promise<unknown> {
    return await this.request('/tui/open-models', { method: 'POST', body: {} })
  }

  async submitTuiPrompt(): Promise<unknown> {
    return await this.request('/tui/submit-prompt', { method: 'POST', body: {} })
  }

  async clearTuiPrompt(): Promise<unknown> {
    return await this.request('/tui/clear-prompt', { method: 'POST', body: {} })
  }

  async executeTuiCommand(command: string): Promise<unknown> {
    return await this.request('/tui/execute-command', { method: 'POST', body: { command } })
  }

  async showTuiToast(input: unknown): Promise<unknown> {
    return await this.request('/tui/show-toast', { method: 'POST', body: input })
  }

  async publishTuiEvent(event: unknown): Promise<unknown> {
    return await this.request('/tui/publish', { method: 'POST', body: event })
  }

  async selectTuiSession(sessionID: string): Promise<unknown> {
    return await this.request('/tui/select-session', { method: 'POST', body: { sessionID } })
  }

  async getTuiControlNext(): Promise<unknown> {
    return await this.request('/tui/control/next')
  }

  async respondTuiControl(response: unknown): Promise<unknown> {
    return await this.request('/tui/control/response', { method: 'POST', body: response })
  }

  async listWorkspaceAdapters(): Promise<unknown[]> {
    const data = await this.request('/experimental/workspace/adapter')
    return Array.isArray(data) ? data : []
  }

  async listWorkspaces(): Promise<unknown[]> {
    const data = await this.request('/experimental/workspace')
    return Array.isArray(data) ? data : []
  }

  async createWorkspace(input: unknown): Promise<unknown> {
    return await this.request('/experimental/workspace', { method: 'POST', body: input })
  }

  async syncWorkspaceList(): Promise<unknown> {
    return await this.request('/experimental/workspace/sync-list', { method: 'POST', body: {} })
  }

  async getWorkspaceStatus(): Promise<unknown[]> {
    const data = await this.request('/experimental/workspace/status')
    return Array.isArray(data) ? data : []
  }

  async removeWorkspace(id: string): Promise<unknown> {
    return await this.request(`/experimental/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async warpWorkspace(input: unknown): Promise<unknown> {
    return await this.request('/experimental/workspace/warp', { method: 'POST', body: input })
  }

  async listV2Sessions(query: Record<string, QueryValue> = {}): Promise<unknown> {
    return await this.request('/api/session', { query })
  }

  async promptV2(sessionID: string, prompt: unknown, delivery?: unknown): Promise<unknown> {
    return await this.request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: 'POST',
      body: delivery === undefined ? { prompt } : { prompt, delivery },
    })
  }

  async compactV2(sessionID: string): Promise<unknown> {
    return await this.request(`/api/session/${encodeURIComponent(sessionID)}/compact`, {
      method: 'POST',
      body: {},
    })
  }

  async waitV2(sessionID: string): Promise<unknown> {
    return await this.request(`/api/session/${encodeURIComponent(sessionID)}/wait`, {
      method: 'POST',
      body: {},
    })
  }

  async contextV2(sessionID: string): Promise<unknown[]> {
    const data = await this.request(`/api/session/${encodeURIComponent(sessionID)}/context`)
    return Array.isArray(data) ? data : []
  }

  async messagesV2(sessionID: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
    return await this.request(`/api/session/${encodeURIComponent(sessionID)}/message`, { query })
  }

  async listV2Models(query: Record<string, QueryValue> = {}): Promise<unknown[]> {
    const data = await this.request('/api/model', { query })
    return Array.isArray(data) ? data : []
  }

  async listV2Providers(query: Record<string, QueryValue> = {}): Promise<unknown[]> {
    const data = await this.request('/api/provider', { query })
    return Array.isArray(data) ? data : []
  }

  async getV2Provider(providerID: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
    return await this.request(`/api/provider/${encodeURIComponent(providerID)}`, { query })
  }

  async getExperimentalConsole(): Promise<unknown> {
    return await this.request('/experimental/console')
  }

  async getExperimentalConsoleOrgs(): Promise<unknown> {
    return await this.request('/experimental/console/orgs')
  }

  async switchExperimentalConsole(input: unknown): Promise<unknown> {
    return await this.request('/experimental/console/switch', { method: 'POST', body: input })
  }

  async getExperimentalTools(provider: string, model: string): Promise<unknown> {
    return await this.request('/experimental/tool', { query: { provider, model } })
  }

  async getExperimentalToolIDs(): Promise<unknown[]> {
    const data = await this.request('/experimental/tool/ids')
    return Array.isArray(data) ? data : []
  }

  async listExperimentalWorktrees(): Promise<unknown[]> {
    const data = await this.request('/experimental/worktree')
    return Array.isArray(data) ? data : []
  }

  async createExperimentalWorktree(input: unknown = {}): Promise<unknown> {
    return await this.request('/experimental/worktree', { method: 'POST', body: input })
  }

  async removeExperimentalWorktree(directory: string): Promise<unknown> {
    return await this.request('/experimental/worktree', { method: 'DELETE', body: { directory } })
  }

  async resetExperimentalWorktree(directory: string): Promise<unknown> {
    return await this.request('/experimental/worktree/reset', { method: 'POST', body: { directory } })
  }

  async listExperimentalSessions(query: Record<string, QueryValue> = {}): Promise<unknown> {
    return await this.request('/experimental/session', { query })
  }

  async getExperimentalResources(): Promise<unknown> {
    return await this.request('/experimental/resource')
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
      body: { command, arguments: '' },
    })
  }

  async shell(sessionID: string, command: string, opts: { agent?: string } & ModelSelection = {}): Promise<unknown> {
    const model = modelRef(opts)
    return await this.request(`/session/${encodeURIComponent(sessionID)}/shell`, {
      method: 'POST',
      body: { command, agent: opts.agent ?? 'build', ...(model ? { model } : {}) },
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

  async replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<unknown> {
    return await this.request(`/question/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: { answers },
    })
  }

  async rejectQuestion(requestID: string): Promise<unknown> {
    return await this.request(`/question/${encodeURIComponent(requestID)}/reject`, {
      method: 'POST',
      body: {},
    })
  }

  async syncHistory(input: Record<string, unknown>): Promise<unknown> {
    return await this.request('/sync/history', {
      method: 'POST',
      body: input,
    })
  }

  async startSync(): Promise<unknown> {
    return await this.request('/sync/start', { method: 'POST', body: {} })
  }

  async replaySync(events: unknown[], directory?: string): Promise<unknown> {
    return await this.request('/sync/replay', {
      method: 'POST',
      body: directory === undefined ? { events } : { events, directory },
    })
  }

  async stealSyncSession(sessionID: string): Promise<unknown> {
    return await this.request('/sync/steal', { method: 'POST', body: { sessionID } })
  }

  async disposeInstance(): Promise<unknown> {
    return await this.request('/instance/dispose', { method: 'POST', body: {} })
  }

  async request(
    path: string,
    init: {
      method?: string
      body?: unknown
      query?: Record<string, QueryValue>
      headers?: Record<string, string>
    } = {},
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const headers = this.headers({
      Accept: 'application/json',
      ...init.headers,
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
  // WHY the public option still accepts friendly model/provider strings while
  // the wire payload uses OpenCode's nested ModelRef:
  // Agent Code wants one cross-provider prompt shape, but the OpenCode source
  // defines PromptInput.model as `{ providerID, modelID }`. Keeping the
  // conversion here prevents that OpenCode-specific detail from leaking through
  // the package boundary while still allowing callers to pin a model when the
  // inherited local default is not what a test or workflow needs.
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    parts: opts.parts ?? [{ type: 'text', text: opts.prompt }],
  }
  if (opts.agent) body.agent = opts.agent
  const model = modelRef(opts)
  if (model) body.model = model
  if (opts.mode) body.mode = opts.mode
  if (opts.messageID) body.messageID = opts.messageID
  if (opts.noReply !== undefined) body.noReply = opts.noReply
  if (opts.tools) body.tools = opts.tools
  if (opts.format) body.format = opts.format
  if (opts.system) body.system = opts.system
  if (opts.variant) body.variant = opts.variant
  return body
}

function modelRef(opts: ModelSelection): { providerID: string; modelID: string } | undefined {
  const modelID = opts.modelID ?? opts.model
  if (opts.providerID && modelID) return { providerID: opts.providerID, modelID }
  if (!opts.providerID && opts.model?.includes('/')) {
    const [providerID, ...rest] = opts.model.split('/')
    const joined = rest.join('/')
    if (providerID && joined) return { providerID, modelID: joined }
  }
  return undefined
}
