#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { OpencodeHeadless } from '../dist/index.js'

const REPO_ROOT = new URL('../../..', import.meta.url).pathname
const WORKSPACE = '/Users/juliusolsson/Desktop/Development/testing/opencode-work'
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
      return {
        sessionID: oc.activeSessionID,
        assistantText: observed.assistantText,
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

  await runCase('realistic-file-edit', async () => {
    await prepareWorkspace()
    const oc = await startHeadless(WORKSPACE)
    const observed = observe(oc)
    try {
      await oc.ensureSession()
      await oc.prompt({
        prompt: [
          'You are editing a tiny static landing page.',
          'In this workspace, update index.html and styles.css only.',
          'Make the page a polished landing page for "Northstar Analytics".',
          'Requirements:',
          '- Keep it static HTML/CSS.',
          '- Add a hero, three feature cards, and one call to action.',
          '- Include the exact text "Northstar Analytics".',
          '- Include the exact text "Operational clarity for growing teams".',
          '- Do not ask follow-up questions.',
          'When finished, reply with exactly: DONE',
        ].join('\n'),
      })
      await waitFor(() => observed.assistantText.includes('DONE'), {
        label: 'assistant completion marker DONE',
        observed,
      })
      await waitForIdle(observed)
      const html = await readFile(join(WORKSPACE, 'index.html'), 'utf8')
      const css = await readFile(join(WORKSPACE, 'styles.css'), 'utf8')
      assert(html.includes('Northstar Analytics'), 'index.html should include product name')
      assert(
        html.includes('Operational clarity for growing teams'),
        'index.html should include required value prop',
      )
      assert(/<section|<main|class=/i.test(html), 'index.html should look like real markup')
      assert(css.length > 200, 'styles.css should contain meaningful styling')
      return {
        sessionID: oc.activeSessionID,
        assistantText: observed.assistantText.slice(0, 200),
        semanticEvents: observed.semantic.length,
        screenEvents: observed.screen.length,
        committedEvents: observed.committed.length,
        toolSignals: observed.toolSignals,
        htmlBytes: Buffer.byteLength(html),
        cssBytes: Buffer.byteLength(css),
      }
    } finally {
      await oc.stop()
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
    committed: [],
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
  })

  oc.committed.on('event', event => {
    state.committed.push(event)
  })

  oc.on('sse-error', err => {
    state.sseErrors.push(err.message)
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

main().catch(err => {
  console.error(err)
  process.exit(1)
})
