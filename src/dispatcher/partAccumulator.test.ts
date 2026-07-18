import { describe, expect, it, vi } from 'vitest'

import { PartAccumulator } from './partAccumulator.js'

describe('PartAccumulator', () => {
  it('appends deltas without losing the already committed prefix', () => {
    const accumulator = new PartAccumulator()

    expect(accumulator.applyDelta('part-1', 'text', 'hello ')).toBe('hello ')
    expect(accumulator.applyDelta('part-1', 'text', 'world')).toBe('hello world')
    expect(accumulator.getField('part-1', 'text')).toBe('hello world')
  })

  it('truncates at a UTF-8 character boundary and reports the original byte size', () => {
    const onOverflow = vi.fn()
    const accumulator = new PartAccumulator({ maxBytesPerPart: 5, onOverflow })

    expect(accumulator.applyDelta('part-1', 'text', 'ééé')).toBe('éé')
    expect(onOverflow).toHaveBeenCalledWith({
      partID: 'part-1',
      size: 6,
      limit: 5,
    })
  })

  it('evicts the least recently updated part when the active limit is exceeded', () => {
    vi.useFakeTimers()
    try {
      const accumulator = new PartAccumulator({ maxActiveParts: 2 })
      accumulator.applyUpdate('oldest', { text: 'a' })
      vi.advanceTimersByTime(1)
      accumulator.applyUpdate('middle', { text: 'b' })
      vi.advanceTimersByTime(1)
      accumulator.applyUpdate('newest', { text: 'c' })

      expect(accumulator.getPart('oldest')).toBeUndefined()
      expect(accumulator.getPart('middle')).toBeDefined()
      expect(accumulator.getPart('newest')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
