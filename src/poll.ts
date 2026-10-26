/**
 * Shared polling helper for compile progress (documents and threads).
 *
 * /make is the only compile call. Every compile response carries `status`
 * (queued, compiling, compiled, paused, failed, ...) and `progress` (0 to 1).
 */
import {FacesClient} from './client.js'
import {compileProgressLabel, compileStatusOf, msUntilStart, seg} from './utils.js'

export interface PollProgress {
  /** One of the published states; an unknown one already reads as `compiling`. */
  status: string | null
  /** 0 to 1. It is 1 only when compiled, and 0 while queued. */
  progress: number | null
  /** The server is still working on it, including an automatic retry. */
  finishing: boolean | null
  /** Why a compile stopped, when it did. */
  stall_reason: string | null
  /** The scheduled start, or once started when it started; null when it starts at once. */
  starts_at?: string | null
  /** Queued as a rush: it starts now, at the rush rate. */
  rush?: boolean | null
}

export interface PollOptions {
  intervalMs?: number   // default 3000
  /**
   * Default 600000 (10 minutes). Counted from the compile's start: a wait for
   * a scheduled start is added to it.
   */
  timeoutMs?: number
  /** The scheduled start /make answered, so the first wait is counted right. */
  startsAt?: string | null
  onProgress?: (p: PollProgress) => void
  /** Override the GET endpoint path. Defaults to /v1/compile/documents/{id}. */
  endpoint?: string
  /**
   * Re-read the full source once the compile finishes, and return that.
   *
   * Polling uses the cheap status route, which omits `content` and `messages`.
   * Callers that hand this body to --json were returning the whole source
   * before, so the default preserves that at the cost of one request after the
   * loop rather than one per tick. Pass false when the body is discarded.
   */
  fullOnFinish?: boolean
}

/** One progress line for a person: "queued", or "compiling, 43%". */
export function progressLine(p: PollProgress): string {
  return compileProgressLabel(p)
}

/**
 * Poll a compile GET endpoint until a terminal status is reached:
 * `compiled` returns the final GET response; `failed` and `paused` throw, as
 * does the timeout.
 */
export async function pollCompileProgress(
  client: FacesClient,
  id: string,
  opts: PollOptions = {},
): Promise<unknown> {
  const interval = opts.intervalMs ?? 3000
  const timeout = opts.timeoutMs ?? 600_000
  const start = Date.now()
  // Pushed out while the compile waits for its scheduled start.
  let deadline = start + timeout + msUntilStart(opts.startsAt, start)
  const base = opts.endpoint ?? `/v1/compile/documents/${seg(id)}`
  // status_only trims the body to the progress and revision fields. The full
  // GET returns the entire source on every tick: 21 KB for an ordinary
  // document and 257 KB for a long one, every three seconds, to read six
  // numbers. The cheap route carries everything a poller needs, which is what
  // makes this safe.
  const endpoint = base.includes('?') ? `${base}&status_only=true` : `${base}?status_only=true`

  let lastLine = ''

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`Compile timed out after ${Math.round(timeout / 1000)}s`)
    }

    await sleep(interval)

    const data = await client.get(endpoint) as Record<string, unknown>

    const progress: PollProgress = {
      status: compileStatusOf(data.status),
      progress: typeof data.progress === 'number' ? data.progress : null,
      finishing: (data.finishing as boolean) ?? null,
      stall_reason: (data.stall_reason as string) ?? null,
      starts_at: typeof data.starts_at === 'string' ? data.starts_at : null,
      rush: typeof data.rush === 'boolean' ? data.rush : null,
    }
    if (progress.status === 'queued') {
      const now = Date.now()
      const wait = msUntilStart(progress.starts_at, now)
      if (wait > 0) deadline = Math.max(deadline, now + wait + timeout)
    }

    // Only when what a person would read has changed, so a long wait in the
    // queue is one "queued" line rather than one every three seconds.
    const line = progressLine(progress)
    if (line !== lastLine) {
      lastLine = line
      opts.onProgress?.(progress)
    }

    if (progress.status === 'compiled') {
      // One full read at the end, so a caller that prints this body still gets
      // what it always did. The saving is in the loop, not the last request.
      if (opts.fullOnFinish === false) return data
      try {
        return await client.get(base)
      } catch {
        // The compile finished; failing to re-read it is not a compile failure.
        return data
      }
    }

    // While `finishing` is true the server is still retrying it on its own,
    // so waiting is the right thing even through a failure; only a failure
    // with nothing left to try ends the poll. The reason is `stall_reason`,
    // which reading `error` would print over.
    if (progress.status === 'failed' && progress.finishing !== true) {
      throw new Error(
        `Compile failed: ${progress.stall_reason ?? (data.error_code as string) ?? 'no reason given'}\n` +
          'It is out of automatic retries, so this needs a decision rather than more waiting.',
      )
    }

    // A pause holds until someone resumes it, so waiting on one would only
    // run out the timeout and report that instead.
    if (progress.status === 'paused') {
      throw new Error('Compile is paused, and nothing moves until it is resumed. Resume it by running make again.')
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Statuses that mean the compile is no longer running. `paused` is the outcome a
 * pause is waiting for; the rest mean it stopped for some other reason first.
 */
const PAUSE_TERMINAL = new Set(['paused', 'compiled', 'failed', 'not_compiled'])

export interface PausePollOptions {
  intervalMs?: number   // default 1000
  timeoutMs?: number    // default 60000
  onTick?: () => void
  /** Override the GET endpoint path. Defaults to /v1/compile/documents/{id}. */
  endpoint?: string
}

/**
 * Wait for a pause request to actually land.
 *
 * POST /pause only acknowledges the request: it returns `status: "pausing"` and
 * the compile stops shortly after, usually within a few seconds.
 * `status` on the document is the authority on whether it has stopped.
 *
 * Returns that final status: `paused` when the pause landed, `compiled` when
 * the compile finished before it could (a normal race, not an error), `failed`
 * if it died, or `not_compiled` or null when nothing was running. Returns undefined if
 * the timeout expires while it is still stopping: the pause was accepted
 * either way, so callers should report rather than fail.
 */
export async function pollUntilPaused(
  client: FacesClient,
  id: string,
  opts: PausePollOptions = {},
): Promise<string | null | undefined> {
  const interval = opts.intervalMs ?? 1000
  const timeout = opts.timeoutMs ?? 60_000
  const endpoint = opts.endpoint ?? `/v1/compile/documents/${seg(id)}`
  const start = Date.now()

  while (Date.now() - start < timeout) {
    await sleep(interval)
    opts.onTick?.()

    // status_only trims the body to the progress fields: this is a poll loop.
    const data = await client.get(`${endpoint}?status_only=true`) as Record<string, unknown>
    const status = compileStatusOf(data.status)
    if (status === null || PAUSE_TERMINAL.has(status)) return status
  }

  return undefined
}
