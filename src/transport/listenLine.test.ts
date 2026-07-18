import { describe, expect, it } from 'vitest'

import { parseListenLine } from './listenLine.js'

describe('parseListenLine', () => {
  it('extracts the structured address from OpenCode startup output', () => {
    expect(parseListenLine('opencode server listening on http://127.0.0.1:4096')).toEqual({
      url: 'http://127.0.0.1:4096',
      host: '127.0.0.1',
      port: 4096,
    })
  })

  it('ignores unrelated process output', () => {
    expect(parseListenLine('warming providers')).toBeNull()
  })
})
