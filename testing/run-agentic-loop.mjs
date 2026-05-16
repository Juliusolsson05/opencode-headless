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

const REPO_ROOT = new URL('../../..', import.meta.url).pathname
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

      const html = await readFile(join(WORKSPACE, 'index.html'), 'utf8')
      const css = await readFile(join(WORKSPACE, 'styles.css'), 'utf8')
      const checklist = JSON.parse(await readFile(join(WORKSPACE, 'checklist.json'), 'utf8'))
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
      return {
        sessionID,
        ownerSemanticEvents: ownerObserved.semantic.length,
        ownerRawTypes: [...new Set(ownerObserved.raw.map(event => event.type))],
        ownerToolSignals: ownerObserved.toolSignals,
        ownerFileEvents: ownerObserved.fileEvents.length,
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
    if (event.type === 'activity' && event.active === false) state.idle = true
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
