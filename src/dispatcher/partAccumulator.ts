export type PartAccumulatorOverflow = {
  partID: string
  size: number
  limit: number
}

export type PartAccumulatorOptions = {
  maxBytesPerPart?: number
  maxActiveParts?: number
  onOverflow?: (overflow: PartAccumulatorOverflow) => void
}

export type AccumulatedPart = {
  partID: string
  fields: Map<string, string>
  updatedAt: number
}

export class PartAccumulator {
  private readonly maxBytesPerPart: number
  private readonly maxActiveParts: number
  private readonly onOverflow?: (overflow: PartAccumulatorOverflow) => void
  private readonly parts = new Map<string, AccumulatedPart>()

  constructor(opts: PartAccumulatorOptions = {}) {
    this.maxBytesPerPart = opts.maxBytesPerPart ?? 1024 * 1024
    this.maxActiveParts = opts.maxActiveParts ?? 64
    this.onOverflow = opts.onOverflow
  }

  applyDelta(partID: string, field: string, delta: string): string {
    const part = this.getOrCreate(partID)
    const current = part.fields.get(field) ?? ''
    const next = truncateUtf8(current + delta, this.maxBytesPerPart)
    part.fields.set(field, next)
    part.updatedAt = Date.now()
    if (next.length < current.length + delta.length) {
      this.onOverflow?.({
        partID,
        size: Buffer.byteLength(current + delta),
        limit: this.maxBytesPerPart,
      })
    }
    this.evictOldestIfNeeded()
    return next
  }

  applyUpdate(partID: string, fields: Record<string, unknown>): void {
    const part = this.getOrCreate(partID)
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string') part.fields.set(key, value)
    }
    part.updatedAt = Date.now()
    this.evictOldestIfNeeded()
  }

  getField(partID: string, field: string): string {
    return this.parts.get(partID)?.fields.get(field) ?? ''
  }

  getPart(partID: string): AccumulatedPart | undefined {
    return this.parts.get(partID)
  }

  evict(partID: string): void {
    this.parts.delete(partID)
  }

  evictAll(): void {
    this.parts.clear()
  }

  private getOrCreate(partID: string): AccumulatedPart {
    const existing = this.parts.get(partID)
    if (existing) return existing
    const part: AccumulatedPart = {
      partID,
      fields: new Map(),
      updatedAt: Date.now(),
    }
    this.parts.set(partID, part)
    return part
  }

  private evictOldestIfNeeded(): void {
    while (this.parts.size > this.maxActiveParts) {
      let oldest: AccumulatedPart | null = null
      for (const part of this.parts.values()) {
        if (!oldest || part.updatedAt < oldest.updatedAt) oldest = part
      }
      if (!oldest) return
      this.parts.delete(oldest.partID)
    }
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const accepted: string[] = []
  let size = 0
  for (const character of value) {
    const characterSize = Buffer.byteLength(character)
    if (size + characterSize > maxBytes) break
    accepted.push(character)
    size += characterSize
  }
  return accepted.join('')
}
