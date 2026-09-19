import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CommittedChannel } from '../channels/CommittedChannel.js'
import { ScreenChannel } from '../channels/ScreenChannel.js'
import { SemanticChannel } from '../channels/SemanticChannel.js'
import type { ScreenPermissionEvent, ScreenQuestionEvent } from '../channels/types.js'
import { EventDispatcher } from '../dispatcher/EventDispatcher.js'
import type { OpenCodeBusEvent } from '../dispatcher/EventDispatcher.js'
import { permissionRequestFromEvent } from './subject.js'

// agent-code#878. On OpenCode 1.18.30, the structured runtime's permission
// modal read "OpenCode is requesting permission." with no subject, so users
// approved `bash: ls -1` blind. The question modal showed a generic line
// instead of the question.
//
// WHY the inputs are RECORDINGS, not literals: the bug is precisely that
// someone's idea of the payload shape (`title` / `tool` / `action`) stopped
// matching what the server actually sends. These streams are the real
// OpenCode 1.18.30 SSE bus, recorded by opencode-terminal-headless's Stage 0
// live probe (testing/fixtures/live-1.18.30/README.md has the provenance).
// Every event is replayed in its recorded order through the REAL
// EventDispatcher and the REAL channels. That is the same path the app
// consumes, so the test sees whatever the app would see.

type Recording = {
  opencodeVersion: string
  sessionID: string
  sse: { t: number, event: OpenCodeBusEvent }[]
}

function recording(name: string): Recording {
  return JSON.parse(readFileSync(new URL(`../../testing/fixtures/live-1.18.30/${name}.json`, import.meta.url), 'utf8'))
}

function replay(rec: Recording) {
  const screen = new ScreenChannel()
  const permissions: ScreenPermissionEvent['state'][] = []
  const questions: ScreenQuestionEvent['state'][] = []
  screen.on('permission', (event: ScreenPermissionEvent) => permissions.push(event.state))
  screen.on('question', (event: ScreenQuestionEvent) => questions.push(event.state))
  const dispatcher = new EventDispatcher({
    semantic: new SemanticChannel(),
    screen,
    committed: new CommittedChannel(),
    sessionID: rec.sessionID,
  })
  for (const { event } of rec.sse) dispatcher.dispatch(event)
  return { permissions, questions }
}

describe('permission and question subjects on recorded OpenCode 1.18.30 streams', () => {
  it('the recordings are the 1.18.30 shape this fix targets', () => {
    // Guards the premise: if the fixtures are ever re-recorded on a server
    // that changed shape again, this fails first and says so, instead of the
    // assertions below failing with a confusing subject mismatch.
    expect(recording('permission-once').opencodeVersion).toBe('1.18.30')
    const asked = recording('permission-once').sse.find(({ event }) => event.type === 'permission.asked')!.event
    expect(asked.properties).toMatchObject({ permission: 'bash', patterns: ['ls -1'] })
    expect((asked.properties as Record<string, unknown>).tool).toBeTypeOf('object')
  })

  it('the permission modal names what is being asked for', () => {
    const shown = replay(recording('permission-once')).permissions.filter(state => state.visible)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown[0]!.title).toBe('bash: ls -1')
    expect(shown[0]!.requestID).toMatch(/^per_/)
  })

  it('the question modal shows the question the agent asked', () => {
    const shown = replay(recording('question-reject')).questions.filter(state => state.visible)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown[0]!.text).toBe('Do you prefer the color red or blue?')
    expect(shown[0]!.questionID).toMatch(/^que_/)
  })

  it('the pending-permission request (the path that answers the prompt) carries the same subject', () => {
    // OpencodeHeadless builds this request for every permission.asked and
    // keeps it for the reply. It used a second, separately drifted parser;
    // both paths now share one.
    const asked = recording('permission-once').sse.find(({ event }) => event.type === 'permission.asked')!.event
    const request = permissionRequestFromEvent(asked)
    expect(request).toMatchObject({ requestID: expect.stringMatching(/^per_/), title: 'bash: ls -1' })
    expect(request!.sessionID).toBe(recording('permission-once').sessionID)
  })
})
