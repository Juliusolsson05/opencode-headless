export type ListenLine = {
  url: string
  host?: string
  port?: number
}

const LISTEN_RE = /opencode server listening on\s+(https?:\/\/[^\s]+)/i

export function parseListenLine(line: string): ListenLine | null {
  const match = LISTEN_RE.exec(line)
  if (!match) return null

  const url = match[1]
  try {
    const parsed = new URL(url)
    return {
      url,
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
    }
  } catch {
    return { url }
  }
}
