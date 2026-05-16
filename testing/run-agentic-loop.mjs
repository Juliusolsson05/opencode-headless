#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  EventDispatcher,
  OpencodeHeadless,
  PermissionService,
  SyncClient,
} from '../dist/index.js'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const WORKSPACE = '/Users/juliusolsson/Desktop/Development/testing/opencode-work'
const SDK_TYPES = join(REPO_ROOT, 'vendor/opencode-src/packages/sdk/js/src/v2/gen/types.gen.ts')
const DEFAULT_TIMEOUT_MS = 120_000

const results = []

async function main() {
  await prepareWorkspace()

  await runCase('server-auth-smoke', async () => {
    const oc = await startHeadless()
    try {
      const sessions = await oc.client.listSessions()
      assert(Array.isArray(sessions), 'listSessions() should return an array')
      return {
        url: oc.serverUrl,
        sessions: sessions.length,
      }
    } finally {
      await oc.stop()
    }
  })

  await runCase('prompt-roundtrip', async () => {
    const oc = await startHeadless()
    const observed = observe(oc)
    try {
      await oc.ensureSession()
      await oc.prompt({ prompt: 'Reply with exactly: OK' })
      await waitFor(() => observed.assistantText.trim() === 'OK', {
        label: 'assistant text to equal OK',
        observed,
      })
      await waitForIdle(observed)
      const history = await oc.refreshHistory()
      const committedAssistantTexts = observed.committed
        .filter(event => event.type === 'turn_committed' && event.role === 'assistant')
        .map(event => event.text)
        .filter(Boolean)
      assert(
        committedAssistantTexts.some(text => text.trim() === 'OK'),
        'committed assistant history should include OK',
      )
      return {
        sessionID: oc.activeSessionID,
        assistantText: observed.assistantText,
        committedAssistantTexts,
        rawEventTypes: [...new Set(observed.raw.map(event => event.type))],
        semanticEvents: observed.semantic.length,
        screenEvents: observed.screen.length,
        committedEvents: observed.committed.length,
        historyMessages: history.length,
        unknownEvents: observed.unknownEvents,
      }
    } finally {
      await oc.stop()
    }
  })

  await runCase('attach-mode', async () => {
    const owner = await startHeadless()
    const attached = new OpencodeHeadless({
      mode: 'attach',
      serverUrl: owner.serverUrl,
      cwd: REPO_ROOT,
    })
    try {
      await attached.start()
      const sessions = await attached.client.listSessions()
      assert(Array.isArray(sessions), 'attached client should list sessions')
      return {
        ownerUrl: owner.serverUrl,
        attachedUrl: attached.serverUrl,
        sessions: sessions.length,
      }
    } finally {
      await attached.stop()
      await owner.stop()
    }
  })

  await runCase('attach-followup-session', async () => {
    const owner = await startHeadless()
    const ownerObserved = observe(owner)
    let attached
    try {
      const sessionID = await owner.ensureSession()
      await owner.prompt({
        prompt: 'The session codeword is ZEBRA-17. Reply with exactly: READY',
      })
      await waitFor(() => ownerObserved.assistantText.trim() === 'READY', {
        label: 'first turn READY response',
        observed: ownerObserved,
      })
      await waitForIdle(ownerObserved)

      attached = new OpencodeHeadless({
        mode: 'attach',
        serverUrl: owner.serverUrl,
        cwd: REPO_ROOT,
        sessionID,
        pure: true,
      })
      const attachedObserved = observe(attached)
      await attached.start()
      await attached.prompt({
        prompt: 'What is the session codeword? Reply with only the codeword.',
      })
      await waitFor(() => attachedObserved.assistantText.includes('ZEBRA-17'), {
        label: 'attached follow-up to recall codeword',
        observed: attachedObserved,
      })
      await waitForIdle(attachedObserved)
      return {
        sessionID,
        ownerEvents: ownerObserved.semantic.length,
        attachedEvents: attachedObserved.semantic.length,
        ownerRawTypes: [...new Set(ownerObserved.raw.map(event => event.type))],
        answer: attachedObserved.assistantText,
      }
    } finally {
      if (attached) await attached.stop()
      await owner.stop()
    }
  })

  await runCase('permission-service-synthetic', async () => {
    const calls = []
    const fakeFetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const sync = new SyncClient({
      baseUrl: 'http://127.0.0.1:4096',
      cwd: REPO_ROOT,
      fetch: fakeFetch,
    })
    const service = new PermissionService(sync)
    const seen = []
    service.on('asked', req => seen.push({ type: 'asked', req }))
    service.on('replied', reply => seen.push({ type: 'replied', reply }))
    service.remember({
      requestID: 'perm_test_1',
      sessionID: 'ses_test',
      title: 'edit index.html',
      metadata: { tool: 'edit' },
    })
    await service.approveOnce('perm_test_1')
    assert(service.getPending().length === 0, 'permission should be removed after reply')
    assert(calls.length === 1, 'permission reply should issue one HTTP call')
    assert(
      calls[0].url.endsWith('/permission/perm_test_1/reply'),
      'permission reply should hit the OpenCode reply endpoint',
    )
    assert(
      JSON.parse(calls[0].init.body).reply === 'once',
      'permission reply payload should approve once',
    )
    return { seen, calls: calls.map(call => ({ url: call.url, body: call.init.body })) }
  })

  await runCase('permission-dispatch-synthetic', async () => {
    const semantic = new RecordingChannel()
    const screen = new RecordingChannel()
    const committed = new RecordingChannel()
    const dispatcher = new EventDispatcher({ semantic, screen, committed })
    dispatcher.dispatch({
      type: 'permission.asked',
      properties: {
        requestID: 'perm_dispatch_1',
        sessionID: 'ses_dispatch',
        title: 'write styles.css',
      },
    })
    const permission = screen.events.find(event => event[0] === 'permission')?.[1]
    assert(permission, 'permission dispatch should publish a screen permission event')
    assert(permission.state.visible === true, 'permission should be visible')
    assert(
      permission.state.requestID === 'perm_dispatch_1',
      'permission should preserve request id',
    )
    return { permission }
  })

  await runCase('system-dispatch-synthetic', async () => {
    const semantic = new RecordingChannel()
    const screen = new RecordingChannel()
    const committed = new RecordingChannel()
    const dispatcher = new EventDispatcher({ semantic, screen, committed })
    dispatcher.dispatch({
      type: 'mcp.tools.changed',
      properties: {
        server: 'filesystem',
      },
    })
    dispatcher.dispatch({
      type: 'workspace.status',
      properties: {
        workspaceID: 'ws_1',
        status: 'connected',
      },
    })
    const system = screen.events
      .filter(event => event[0] === 'system')
      .map(event => event[1])
    assert(system.length === 2, 'system dispatch should publish mapped system events')
    assert(system[0].category === 'mcp', 'MCP event should map to mcp category')
    assert(system[1].category === 'workspace', 'workspace event should map to workspace category')
    return { system }
  })

  await runCase('session-next-dispatch-synthetic', async () => {
    const semantic = new RecordingChannel()
    const screen = new RecordingChannel()
    const committed = new RecordingChannel()
    const dispatcher = new EventDispatcher({ semantic, screen, committed })
    dispatcher.dispatch({
      type: 'session.next.text.delta',
      properties: {
        sessionID: 'ses_next',
        delta: 'Hello',
      },
    })
    dispatcher.dispatch({
      type: 'session.next.reasoning.delta',
      properties: {
        sessionID: 'ses_next',
        reasoningID: 'reason_next',
        delta: 'Thinking',
      },
    })
    dispatcher.dispatch({
      type: 'session.next.tool.called',
      properties: {
        sessionID: 'ses_next',
        callID: 'tool_next',
        tool: 'bash',
        input: { command: 'pwd' },
      },
    })
    dispatcher.dispatch({
      type: 'session.next.tool.success',
      properties: {
        sessionID: 'ses_next',
        callID: 'tool_next',
        tool: 'bash',
        content: [{ type: 'text', text: '/tmp' }],
      },
    })
    dispatcher.dispatch({
      type: 'session.next.compaction.started',
      properties: {
        sessionID: 'ses_next',
        reason: 'manual',
      },
    })
    const published = semantic.events
      .filter(event => event[0] === 'publish')
      .map(event => event[1][0])
    const compaction = screen.events.find(event => event[0] === 'compaction')?.[1]
    assert(
      published.some(event => event.type === 'text_delta' && event.textDelta === 'Hello'),
      'session.next text delta should map to semantic text',
    )
    assert(
      published.some(event => event.type === 'thinking_delta' && event.textDelta === 'Thinking'),
      'session.next reasoning delta should map to semantic thinking',
    )
    assert(
      published.some(event => event.type === 'tool_input_finalized'),
      'session.next tool called should finalize tool input',
    )
    assert(
      published.some(event => event.type === 'tool_result' && event.isError === false),
      'session.next tool success should map to tool result',
    )
    assert(compaction?.state.active === true, 'session.next compaction should publish screen compaction')
    return { published, compaction }
  })

  await runCase('source-event-union-audit', async () => {
    const source = await readFile(SDK_TYPES, 'utf8')
    const union = source.match(/export type Event =\n(?<body>(?:  \| Event[^\n]+\n)+)/)?.groups?.body
    assert(union, 'SDK v2 Event union should be readable from vendored OpenCode source')
    const eventTypes = [...union.matchAll(/\| (Event[A-Za-z0-9]+)/g)].map(match => match[1])
    const required = [
      'EventMessagePartDelta',
      'EventPermissionAsked',
      'EventQuestionAsked',
      'EventSessionStatus',
      'EventSessionIdle',
      'EventSessionNextToolProgress',
      'EventSessionNextCompactionDelta',
      'EventMcpToolsChanged',
      'EventWorkspaceStatus',
      'EventPtyUpdated',
      'EventCatalogModelUpdated',
    ]
    for (const name of required) {
      assert(eventTypes.includes(name), `SDK event union should include ${name}`)
    }
    assert(eventTypes.length >= 70, 'SDK event union should include the full modern event surface')
    return {
      eventCount: eventTypes.length,
      required,
    }
  })

  await runCase('native-http-contract-synthetic', async () => {
    const calls = []
    const fakeFetch = async (url, init = {}) => {
      calls.push({ url: String(url), init })
      const path = new URL(String(url)).pathname
      const body = [
        '/permission',
        '/question',
        '/command',
        '/agent',
        '/project',
        '/find/file',
        '/file/status',
        '/pty/shells',
        '/experimental/workspace',
        '/api/model',
        '/experimental/tool/ids',
        '/experimental/worktree',
      ].includes(path)
        ? '[]'
        : '{}'
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const sync = new SyncClient({
      baseUrl: 'http://127.0.0.1:4096',
      cwd: WORKSPACE,
      fetch: fakeFetch,
    })
    await sync.prompt({
      sessionID: 'ses_native',
      prompt: 'target model',
      providerID: 'openai',
      modelID: 'gpt-5.4',
      messageID: 'msg_native',
      noReply: true,
      system: 'native system',
      variant: 'default',
      tools: { bash: true },
      format: { type: 'text' },
    })
    await sync.prompt({
      sessionID: 'ses_native',
      prompt: 'slash model',
      model: 'anthropic/claude-sonnet-4-5',
    })
    await sync.command('ses_native', 'do-thing')
    await sync.shell('ses_native', 'printf ok', {
      agent: 'build',
      providerID: 'openai',
      modelID: 'gpt-5.4',
    })
    await sync.getPaths()
    await sync.listProviders()
    await sync.getProviderAuthMethods()
    await sync.getConfig()
    await sync.getProviderConfig()
    await sync.listProjects()
    await sync.getCurrentProject()
    await sync.listAgents()
    await sync.findFile('index', { type: 'file', limit: 20 })
    await sync.readFileContent('index.html')
    await sync.getFileStatus()
    await sync.getVcsStatus()
    await sync.getMcpStatus()
    await sync.startMcpAuth('filesystem')
    await sync.callbackMcpAuth('filesystem', 'oauth-code')
    await sync.authenticateMcp('filesystem')
    await sync.removeMcpAuth('filesystem')
    await sync.listPtyShells()
    await sync.createPtyConnectToken('pty_native')
    await sync.openTuiModels()
    await sync.listWorkspaces()
    await sync.listV2Models()
    await sync.messagesV2('ses_native', { limit: 20, order: 'desc' })
    await sync.getExperimentalToolIDs()
    await sync.listExperimentalWorktrees()
    await sync.listExperimentalSessions({ limit: 20 })
    await sync.getExperimentalResources()
    await sync.listPermissions()
    await sync.listQuestions()
    await sync.replyQuestion('question_native', [['Yes']])
    await sync.rejectQuestion('question_native')
    await sync.startSync()
    await sync.stealSyncSession('ses_native')
    await sync.disposeInstance()

    const bodies = calls.map(call => ({
      path: new URL(call.url).pathname,
      body: call.init.body ? JSON.parse(call.init.body) : undefined,
      cwd: call.init.headers?.['x-opencode-directory'],
    }))
    assert(
      bodies[0].body.model.providerID === 'openai' && bodies[0].body.model.modelID === 'gpt-5.4',
      'prompt should serialize explicit model as OpenCode ModelRef',
    )
    assert(
      bodies[0].body.messageID === 'msg_native' &&
        bodies[0].body.noReply === true &&
        bodies[0].body.system === 'native system' &&
        bodies[0].body.tools.bash === true,
      'prompt should preserve richer OpenCode PromptInput fields',
    )
    assert(
      bodies[1].body.model.providerID === 'anthropic' &&
        bodies[1].body.model.modelID === 'claude-sonnet-4-5',
      'prompt should parse provider/model shorthand into OpenCode ModelRef',
    )
    assert(
      bodies.some(entry => entry.path === '/session/ses_native/command' && entry.body.arguments === ''),
      'command should include OpenCode command arguments field',
    )
    assert(
      bodies.some(entry => entry.path === '/session/ses_native/shell' && entry.body.command === 'printf ok'),
      'shell should call OpenCode native shell endpoint',
    )
    assert(
      bodies.some(
        entry =>
          entry.path === '/session/ses_native/shell' &&
          entry.body.model.providerID === 'openai' &&
          entry.body.model.modelID === 'gpt-5.4',
      ),
      'shell should serialize model selection as OpenCode ModelRef',
    )
    assert(
      bodies.some(entry => entry.path === '/question/question_native/reply'),
      'question reply should call OpenCode native question endpoint',
    )
    assert(
      calls.some(call => String(call.url).includes('/find/file?query=index&type=file&limit=20')),
      'file search helper should serialize OpenCode file query parameters',
    )
    assert(
      calls.some(call => String(call.url).includes('/file/content?path=index.html')),
      'file content helper should serialize OpenCode file path parameter',
    )
    assert(
      calls.some(call => new URL(String(call.url)).pathname === '/tui/open-models'),
      'TUI model dialog helper should call the native OpenCode TUI route',
    )
    assert(
      calls.some(call => new URL(String(call.url)).pathname === '/api/model'),
      'v2 model helper should call the native OpenCode v2 model route',
    )
    assert(
      calls.some(
        call =>
          new URL(String(call.url)).pathname === '/instance/dispose' &&
          call.init.method === 'POST',
      ),
      'dispose helper should call the OpenCode instance dispose endpoint',
    )
    assert(
      calls.some(
        call =>
          new URL(String(call.url)).pathname === '/pty/pty_native/connect-token' &&
          call.init.headers?.['x-opencode-ticket'] === '1',
      ),
      'PTY connect token helper should send OpenCode ticket header',
    )
    assert(
      calls.some(call => new URL(String(call.url)).pathname === '/mcp/filesystem/auth'),
      'MCP OAuth helpers should call native auth routes',
    )
    assert(
      calls.some(call => new URL(String(call.url)).pathname === '/api/session/ses_native/message'),
      'v2 message helper should call the native v2 message route',
    )
    assert(
      bodies.every(entry => entry.cwd === WORKSPACE),
      'native requests should preserve workspace routing header',
    )
    return { bodies }
  })

  await runCase('agentic-multiturn-repair', async () => {
    await prepareWorkspace()
    const owner = await startHeadless(WORKSPACE)
    const ownerObserved = observe(owner)
    let attached
    try {
      const sessionID = await owner.ensureSession()
      await owner.prompt({
        prompt: [
          'This is a multi-turn integration test.',
          'Use one bash tool call with node -e.',
          'Create index.html, styles.css, and checklist.json.',
          'index.html must include "Northstar Analytics" and a section with id="status".',
          'styles.css must include at least one @media query.',
          'checklist.json must contain {"phase":1,"needsFollowup":true}.',
          'After the files are written, reply exactly: PHASE_ONE_DONE',
        ].join('\n'),
      })
      await waitFor(() => ownerObserved.assistantText.includes('PHASE_ONE_DONE'), {
        label: 'phase one completion marker',
        observed: ownerObserved,
      })
      await waitForIdle(ownerObserved)

      await owner.prompt({
        prompt: [
          'Now perform the follow-up turn.',
          'Use bash to inspect the three files.',
          'If checklist.json says needsFollowup true, update it to {"phase":2,"needsFollowup":false,"verified":true}.',
          'Also append the exact text "Operational clarity for growing teams" to index.html if it is missing.',
          'Reply exactly: REPAIR_DONE',
        ].join('\n'),
      })
      await waitFor(() => ownerObserved.assistantText.includes('REPAIR_DONE'), {
        label: 'repair completion marker',
        observed: ownerObserved,
      })
      await waitForIdle(ownerObserved)

      let html = await readFile(join(WORKSPACE, 'index.html'), 'utf8')
      let css = await readFile(join(WORKSPACE, 'styles.css'), 'utf8')
      let checklist = JSON.parse(await readFile(join(WORKSPACE, 'checklist.json'), 'utf8'))
      if (
        !html.includes('Operational clarity for growing teams') ||
        checklist.phase !== 2 ||
        checklist.needsFollowup !== false ||
        checklist.verified !== true
      ) {
        // WHY this case performs a real corrective turn instead of failing
        // immediately:
        // The package is meant to support Agent Code's long-running agentic
        // loop, where the host verifies externally observable state and feeds
        // mistakes back into the provider. A model that claims completion
        // before the filesystem matches the claim is exactly the class of
        // behavior this temporary harness should exercise.
        await owner.prompt({
          prompt: [
            'External verification found the previous repair incomplete.',
            `index.html contains required value prop: ${html.includes('Operational clarity for growing teams')}`,
            `checklist state: ${JSON.stringify(checklist)}`,
            'Use bash with node -e to make the filesystem match the requirements now.',
            'index.html must contain the exact text "Operational clarity for growing teams".',
            'checklist.json must be exactly {"phase":2,"needsFollowup":false,"verified":true} except whitespace.',
            'After re-reading both files and confirming the state, reply exactly: CORRECTION_DONE',
          ].join('\n'),
        })
        await waitFor(() => ownerObserved.assistantText.includes('CORRECTION_DONE'), {
          label: 'correction completion marker',
          observed: ownerObserved,
        })
        await waitForIdle(ownerObserved)
        html = await readFile(join(WORKSPACE, 'index.html'), 'utf8')
        css = await readFile(join(WORKSPACE, 'styles.css'), 'utf8')
        checklist = JSON.parse(await readFile(join(WORKSPACE, 'checklist.json'), 'utf8'))
      }

      attached = new OpencodeHeadless({
        mode: 'attach',
        serverUrl: owner.serverUrl,
        cwd: WORKSPACE,
        sessionID,
        pure: true,
      })
      const attachedObserved = observe(attached)
      await attached.start()
      await attached.prompt({
        prompt: [
          'Continue this existing session.',
          'Use bash to read checklist.json only.',
          'If verified is true and needsFollowup is false, reply exactly: VERIFIED_TRUE',
          'Otherwise reply exactly: VERIFIED_FALSE',
        ].join('\n'),
      })
      await waitFor(() => /VERIFIED_(TRUE|FALSE)/.test(attachedObserved.assistantText), {
        label: 'attached verification marker',
        observed: attachedObserved,
      })
      await waitForIdle(attachedObserved)

      assert(html.includes('Northstar Analytics'), 'multi-turn html should keep product name')
      assert(
        html.includes('Operational clarity for growing teams'),
        'follow-up turn should add the required value prop',
      )
      assert(css.includes('@media'), 'multi-turn css should include a media query')
      assert(checklist.phase === 2, 'follow-up turn should advance checklist phase')
      assert(checklist.needsFollowup === false, 'follow-up turn should clear needsFollowup')
      assert(checklist.verified === true, 'follow-up turn should verify checklist')
      assert(
        attachedObserved.assistantText.includes('VERIFIED_TRUE'),
        'attached continuation should observe verified state',
      )
      const foundHtml = await owner.client.findFile('index.html', { type: 'file', limit: 10 })
      const nativeHtml = await owner.client.readFileContent('index.html')
      const fileStatus = await owner.client.getFileStatus()
      const providers = await owner.client.listProviders()
      assert(
        foundHtml.some(path => path.endsWith('index.html')),
        'native file search should find the generated landing page',
      )
      assert(
        JSON.stringify(nativeHtml).includes('Northstar Analytics'),
        'native file content should include generated landing page text',
      )
      assert(Array.isArray(fileStatus), 'native file status should return an array')
      assert(providers && typeof providers === 'object', 'native provider listing should return data')
      return {
        sessionID,
        ownerSemanticEvents: ownerObserved.semantic.length,
        ownerRawTypes: [...new Set(ownerObserved.raw.map(event => event.type))],
        ownerToolSignals: ownerObserved.toolSignals,
        ownerFileEvents: ownerObserved.fileEvents.length,
        nativeFoundHtml: foundHtml,
        nativeFileStatusCount: fileStatus.length,
        attachedSemanticEvents: attachedObserved.semantic.length,
        attachedAnswer: attachedObserved.assistantText,
        checklist,
      }
    } finally {
      if (attached) await attached.stop()
      await owner.stop()
    }
  })

  console.log('\nRESULTS')
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}`)
    console.log(JSON.stringify(result.details, null, 2))
  }

  if (results.some(result => !result.ok)) process.exit(1)
}

async function startHeadless(cwd = REPO_ROOT, opts = {}) {
  const oc = new OpencodeHeadless({
    cwd,
    startupTimeoutMs: 20_000,
    pure: true,
    ...opts,
  })
  await oc.start()
  assert(oc.serverUrl, 'serverUrl should be set after start')
  return oc
}

function observe(oc) {
  const state = {
    assistantText: '',
    idle: false,
    semantic: [],
    screen: [],
    fileEvents: [],
    committed: [],
    raw: [],
    unknownEvents: [],
    toolSignals: [],
    sseErrors: [],
  }

  oc.semantic.on('event', event => {
    state.semantic.push(event)
    if (event.type === 'turn_delta') state.assistantText = event.fullText
    if (event.type === 'turn_completed' && typeof event.fullText === 'string') {
      state.assistantText = event.fullText
    }
    if (event.type === 'unknown_event') state.unknownEvents.push(event.upstreamType)
    if (
      event.type === 'block_started' ||
      event.type === 'block_completed' ||
      event.type === 'tool_result' ||
      event.type === 'tool_input_delta' ||
      event.type === 'tool_input_finalized'
    ) {
      state.toolSignals.push(event.type)
    }
  })

  oc.screen.on('event', event => {
    state.screen.push(event)
    if (event.type === 'activity') state.idle = event.active === false
    if (event.type === 'file') state.fileEvents.push(event)
  })

  oc.committed.on('event', event => {
    state.committed.push(event)
  })

  oc.on('sse-error', err => {
    state.sseErrors.push(err.message)
  })

  oc.on('raw', event => {
    state.raw.push(event)
  })

  oc.on('permission', req => {
    void oc.permissionService.approveOnce(req.requestID).catch(err => {
      state.sseErrors.push(`permission approval failed: ${err.message}`)
    })
  })

  return state
}

async function runCase(name, fn) {
  console.log(`\nCASE ${name}`)
  try {
    const details = await fn()
    results.push({ name, ok: true, details })
    console.log(`PASS ${name}`)
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    results.push({
      name,
      ok: false,
      details: {
        message: error.message,
        stack: error.stack,
      },
    })
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

async function waitFor(predicate, opts) {
  const start = Date.now()
  while (Date.now() - start < (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
    if (predicate()) return
    if (opts.observed?.sseErrors?.length) {
      throw new Error(`SSE errors: ${opts.observed.sseErrors.join('; ')}`)
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${opts.label}`)
}

async function waitForIdle(observed) {
  await waitFor(() => observed.idle, {
    label: 'session idle activity event',
    observed,
    timeoutMs: 30_000,
  })
}

async function prepareWorkspace() {
  await rm(WORKSPACE, { recursive: true, force: true })
  await mkdir(WORKSPACE, { recursive: true })
  await writeFile(
    join(WORKSPACE, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Placeholder</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main>
      <h1>Placeholder landing page</h1>
      <p>This file is intentionally plain before OpenCode edits it.</p>
    </main>
  </body>
</html>
`,
  )
  await writeFile(
    join(WORKSPACE, 'styles.css'),
    `body {
  font-family: system-ui, sans-serif;
  margin: 0;
}
`,
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

class RecordingChannel {
  events = []
  publishPermission(state) {
    const ev = { type: 'permission', state, ts: Date.now() }
    this.emit('permission', ev)
    this.emit('event', ev)
  }
  publishActivity(params) {
    const ev = { type: 'activity', ...params, ts: Date.now() }
    this.emit('activity', ev)
    this.emit('event', ev)
  }
  publishCompaction(state) {
    const ev = { type: 'compaction', state, ts: Date.now() }
    this.emit('compaction', ev)
    this.emit('event', ev)
  }
  publishFile(params) {
    const ev = { type: 'file', ...params, ts: Date.now() }
    this.emit('file', ev)
    this.emit('event', ev)
  }
  publishSystem(params) {
    const ev = { type: 'system', ...params, ts: Date.now() }
    this.emit('system', ev)
    this.emit('event', ev)
  }
  publishMessage(...args) {
    this.emit('message', args)
  }
  publish(...args) {
    this.emit('publish', args)
  }
  publishTurnStarted(ev) {
    this.emit('turn_started', ev)
  }
  publishTurnDelta(ev) {
    this.emit('turn_delta', ev)
  }
  publishTurnCompleted(ev) {
    this.emit('turn_completed', ev)
  }
  emit(...args) {
    this.events.push(args)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
