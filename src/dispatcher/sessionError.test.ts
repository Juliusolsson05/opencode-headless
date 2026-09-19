import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

import { CommittedChannel } from '../channels/CommittedChannel.js'
import { ScreenChannel } from '../channels/ScreenChannel.js'
import { SemanticChannel } from '../channels/SemanticChannel.js'
import { EventDispatcher } from './EventDispatcher.js'

// Agent Code #1018: an orchestration child's usage-limit failure reached the
// parent as "OpenCode session error". The error is the REAL one from an
// OpenCode 1.18.31 database row (testing/fixtures/session-error), and
// session.error carries it as `error` beside the sessionID.
const recorded = JSON.parse(readFileSync(new URL('../../testing/fixtures/session-error/usage-limit-1.18.31.json', import.meta.url), 'utf8')) as {
  sessionID: string
  error: { name: string; data: { message: string } }
}

it('reports the provider\'s own text for a session error, not the generic fallback', () => {
  const semantic = new SemanticChannel()
  const errors: Array<{ message: string }> = []
  semantic.on('api_error', event => errors.push(event as { message: string }))
  const dispatcher = new EventDispatcher({ semantic, screen: new ScreenChannel(), committed: new CommittedChannel(), sessionID: recorded.sessionID })
  dispatcher.dispatch({ type: 'session.error', properties: { sessionID: recorded.sessionID, error: recorded.error } })
  expect(errors).toEqual([expect.objectContaining({ message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-09-19 14:14:24', errorType: 'APIError' })])
})

// Agent Code #1018 review: a consumer asking "did this turn fail?" must be
// able to tell a provider failure from an interruption and from an
// instance-wide problem, without parsing the message.
function dispatchError(properties: Record<string, unknown>) {
  const semantic = new SemanticChannel()
  const errors: Array<Record<string, unknown>> = []
  semantic.on('api_error', event => errors.push(event as Record<string, unknown>))
  const dispatcher = new EventDispatcher({ semantic, screen: new ScreenChannel(), committed: new CommittedChannel(), sessionID: recorded.sessionID })
  dispatcher.dispatch({ type: 'session.error', properties })
  return errors
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../testing/fixtures/session-error/${name}.json`, import.meta.url), 'utf8')) as {
  sessionID?: string
  error: { name: string; data: { message: string } }
}

it('names a user abort as MessageAbortedError, from the recorded row', () => {
  const abort = fixture('user-abort-1.18.31')
  // The recorded row belongs to another session; the dispatcher's own session
  // is the one this error is published for.
  expect(dispatchError({ sessionID: recorded.sessionID, error: abort.error }))
    .toEqual([expect.objectContaining({ message: 'Aborted', errorType: 'MessageAbortedError' })])
})

it('still shows an instance-wide error with no sessionID, marked instance rather than as this turn\'s failure', () => {
  const instance = fixture('instance-skill-parse-1.18')
  expect(dispatchError({ error: instance.error }))
    .toEqual([expect.objectContaining({ message: instance.error.data.message, errorType: 'instance' })])
})
