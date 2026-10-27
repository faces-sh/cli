import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** This CLI's version, from its own package.json, or undefined when that cannot be read. */
export const CLI_VERSION: string | undefined = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {version?: string}).version
  } catch {
    return undefined
  }
})()

/**
 * What to say when the API looks to have changed under this CLI.
 *
 * The API renames and retires fields as it goes, and an agent driving the CLI
 * sees only what is printed: an empty line gives it nothing to act on, and a
 * named cause with the update command lets it fix things itself.
 */
export function outOfDateHint(latest?: string | null): string {
  const version = CLI_VERSION ? ` (${CLI_VERSION})` : ''
  // On the newest release an update cannot help, and saying it can sends an
  // agent round a reinstall loop: what is left is a bug in this CLI.
  if (latest && CLI_VERSION && compareVersions(CLI_VERSION, latest) >= 0) {
    return `Faces CLI ${CLI_VERSION} is up to date (the latest on npm is ${latest}), so this looks like a Faces CLI bug rather than an old install. ` +
      'Please report it, with the command you ran: https://github.com/faces-sh/cli/issues'
  }

  if (latest && CLI_VERSION) {
    return `Your Faces CLI (${CLI_VERSION}) is out of date; the latest is ${latest}. Update with \`npm install -g @faces-sh/cli@latest\` and try again.`
  }

  return `Your Faces CLI${version} may be out of date. Update with \`npm install -g @faces-sh/cli@latest\` and try again.`
}

/** -1, 0 or 1 for dotted numeric versions; anything after a `-` is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }

  return 0
}

const DEFAULT_API = 'https://api.faces.sh'

const LATEST_CACHE = path.join(os.homedir(), '.faces', 'latest-version.json')
const LATEST_TTL_MS = 6 * 3600_000

/**
 * The newest release of this CLI on npm, or null when it cannot be learned quickly.
 *
 * Only asked when an error already looks like an old install, and cached, so a
 * working CLI never pays for it. Offline, the hint falls back to "may be".
 */
export async function latestCliVersion(): Promise<string | null> {
  try {
    const cached = JSON.parse(fs.readFileSync(LATEST_CACHE, 'utf8')) as {latest?: string; checked_at?: number}
    if (cached.latest && Date.now() - (cached.checked_at ?? 0) < LATEST_TTL_MS) return cached.latest
  } catch {
    // no cache yet
  }

  try {
    const resp = await fetch('https://registry.npmjs.org/@faces-sh%2fcli/latest', {signal: AbortSignal.timeout(1500)})
    if (!resp.ok) return null
    const latest = ((await resp.json()) as {version?: string}).version ?? null
    if (latest) {
      try {
        fs.mkdirSync(path.dirname(LATEST_CACHE), {recursive: true})
        fs.writeFileSync(LATEST_CACHE, JSON.stringify({latest, checked_at: Date.now()}))
      } catch {
        // a cache that cannot be written only costs the next lookup
      }
    }

    return latest
  } catch {
    return null
  }
}

/**
 * Fields a response was expected to carry and does not, as a note naming them
 * and the update, or undefined when none are missing.
 */
export function missingFieldsNote(data: unknown, fields: string[]): string | undefined {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const missing = fields.filter((f) => o[f] === undefined || o[f] === null)
  if (missing.length === 0) return undefined
  const named = missing.map((f) => `\`${f}\``).join(' or ')
  return `The Faces API response did not include ${named}. ${outOfDateHint()}`
}

/**
 * Whether a refusal looks like the API having moved, rather than something
 * wrong with what was asked.
 *
 * A route that is gone answers the framework's bare "Not Found", where a
 * missing face or document names itself. A body this CLI built missing a
 * top-level field, or carrying one the API no longer takes, is the CLI's
 * shape, not the user's input; a fault deeper in, like a question in a
 * questions file, is left alone.
 */
export function looksOutOfDate(status: number, message: string): boolean {
  if (status === 404) return message === 'Not Found'
  if (status === 405 || status === 410) return true
  if (status === 422) return /\b(body|query) → [\w-]+: (Field required|Extra inputs are not permitted)/.test(message)
  return false
}

export class FacesAPIError extends Error {
  statusCode: number
  errorCode?: string
  fallbackAvailable?: boolean
  details?: Record<string, unknown>
  /** Seconds from a `Retry-After` header, when the server sent one as a number. */
  retryAfter?: number
  /** The server's `retryable`, when it said: false means the same request will fail again. */
  retryable?: boolean

  constructor(
    statusCode: number,
    message: string,
    opts?: {errorCode?: string; fallbackAvailable?: boolean; details?: Record<string, unknown>; retryAfter?: number; retryable?: boolean},
  ) {
    super(message)
    this.statusCode = statusCode
    this.name = 'FacesAPIError'
    this.errorCode = opts?.errorCode
    this.fallbackAvailable = opts?.fallbackAvailable
    this.details = opts?.details
    this.retryAfter = opts?.retryAfter
    this.retryable = opts?.retryable ?? (typeof opts?.details?.retryable === 'boolean' ? opts.details.retryable : undefined)
  }
}

/**
 * What to do about a refusal that can come from almost any route.
 *
 * These hinge on the account, which no single command owns: allowances are
 * spent by compiling and chat alike, credit by everything, and an unfinished
 * ChatGPT reply can end a chat, a compile interview or a style build. Attached
 * here so every command says it, rather than the few that remembered.
 *
 * The server's message is shown as it is; these only add the command that
 * acts on it.
 *   - 429 naming an allowance: a plan's allowance is used and api_fallback is
 *     off. The message says which, when it resets, and that fallback would
 *     continue on credits. Told apart from an ordinary rate limit by that.
 *   - 402: no credit. That includes decisions on every plan, which are
 *     charged at provider cost on Connect and Pro too.
 */
export function refusalGuidance(status: number, errorCode: string | undefined, message: string): string | undefined {
  if (status === 429 && /allowance/i.test(message)) {
    return 'To continue on credits until it resets: faces account:preferences api_fallback true'
  }
  // The per-minute limit, once the one retry has been refused too. Its
  // message names the plan's limit and the wait.
  if (status === 429 && /rate limit/i.test(message)) {
    return 'Wait that long before asking again: a request sent sooner is refused too. Limits per plan: https://api.faces.sh/v1/rates'
  }
  // A top-up refused for want of a card would otherwise be told to top up.
  if (status === 402 && /card/i.test(message)) return 'Add a card with: faces billing:card-setup'
  if (status === 401) return 'Check what you are signed in with: faces auth:whoami. To sign in again: faces auth:login'
  // A rush the plan's allowance covers still pays its premium from credit.
  if (status === 402 && errorCode === 'insufficient_credit_for_rush') {
    return 'Add credit with: faces billing:topup --amount <usd>, or run make again without --rush to start at the scheduled time.'
  }
  if (status === 402) return 'Add credit with: faces billing:topup --amount <usd>'
  // The ChatGPT route cannot serve this request: on Free there is none, and on
  // Connect or Pro the model or the link may not allow it. The server says
  // which. Nothing was charged.
  if (status === 422 && errorCode === 'oauth_only_unavailable') {
    return (
      'To run it on credits instead, drop --oauth-only. On Free, OAuth-only needs Connect or Pro: ' +
      'faces billing:subscription:activate'
    )
  }
  // A formula whose result has nothing in it: the server's message says which
  // operation came out empty. Nothing was charged.
  if (status === 422 && errorCode === 'empty_composite') {
    return 'Nothing is left once the formula is applied, so there is no face to answer. Use a formula whose result is not empty, such as a union (|).'
  }
  if ((status === 502 || status === 503) && errorCode === 'oauth_incomplete') {
    return (
      'ChatGPT stopped its reply partway, twice in a row. Nothing was charged; try again. To let a ' +
      'reply like this finish on the paid route instead: faces account:preferences api_fallback true'
    )
  }
  return undefined
}

/**
 * The sentence inside an OAuth refusal's `detail`.
 *
 * Those arrive wrapped as `{detail: {error, detail, upstream_status}}`, and the
 * inner `detail` is often the provider's own JSON body as a string. Printed
 * whole, the one useful sentence sits three escapes deep in a blob.
 */
export function readableDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined
  try {
    const inner = JSON.parse(detail) as unknown
    if (inner && typeof inner === 'object') {
      const o = inner as Record<string, unknown>
      const said = o.detail ?? o.message ?? (o.error as Record<string, unknown> | undefined)?.message
      if (typeof said === 'string' && said.trim()) return said
    }
  } catch {
    // not JSON: the string is the sentence
  }
  return detail
}

/**
 * `Retry-After` as seconds. Only the delta-seconds form is read: the API sends
 * that, and an HTTP date would need a clock that agrees with the server's to
 * mean anything.
 */
export function parseRetryAfter(raw: string | null | undefined): number | undefined {
  if (!raw || !/^\s*\d+\s*$/.test(raw)) return undefined
  return Number(raw.trim())
}

/** The longest rate-limit wait sat out before asking again: the limit is per minute. */
export const MAX_RATE_LIMIT_WAIT_S = 60

/**
 * Seconds to wait before the one retry of a rate-limited request, or undefined
 * to give the 429 back as it is: no `Retry-After`, a wait past a minute, or a
 * used allowance, which is a different refusal that shares the status.
 */
export function rateLimitWait(retryAfter: number | undefined, body: string): number | undefined {
  if (retryAfter === undefined || retryAfter > MAX_RATE_LIMIT_WAIT_S) return undefined
  if (/allowance/i.test(body)) return undefined
  return retryAfter
}

export interface ResponseWithHeaders<T = unknown> {
  data: T
  headers: Record<string, string>
}

export class FacesClient {
  private baseUrl: string
  /**
   * The refusal from the most recent request, cleared by any success. Commands
   * re-raise refusals as text, often reworded, which loses the status and
   * error_code; the --json error reads them here.
   */
  lastError?: FacesAPIError
  /** Why saved credentials were not sent to this base URL, to explain a refusal. */
  private withheld?: string
  private keySaved: boolean
  private token?: string
  private apiKey?: string

  constructor(baseUrl: string, token?: string, apiKey?: string, withheld?: string, keySaved = false) {
    this.withheld = withheld
    this.keySaved = keySaved
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.apiKey = apiKey
  }

  private url(p: string): string {
    const full = `${this.baseUrl}${p}`
    // The last guard behind seg(): a path the URL parser would rewrite (a dot
    // segment, encoded or not) is going somewhere other than it says.
    const parsed = new URL(full)
    const sent = full.slice(parsed.origin.length).split(/[?#]/)[0]
    if (parsed.pathname !== sent) {
      throw new Error(`Refusing to send a request whose path would be rewritten: ${sent}`)
    }

    return full
  }

  authHeader(requireJwt = false): Record<string, string> {
    if (requireJwt) {
      if (!this.token) {
        throw new Error(this.withheld ?? 'JWT login required. Run: faces auth:login')
      }

      return {Authorization: `Bearer ${this.token}`}
    }

    // API key takes priority over saved JWT (explicit key = deliberate choice)
    if (this.apiKey) return {Authorization: `Bearer ${this.apiKey}`}
    if (this.token) return {Authorization: `Bearer ${this.token}`}
    // Thrown rather than exiting here, so --json still answers in JSON.
    throw new Error(this.withheld ?? 'Authentication required. Run: faces auth:login or set FACES_API_KEY')
  }

  private wrapNetworkError(err: unknown, path: string): never {
    // fetch says only "fetch failed"; the cause says whether the name did not
    // resolve, the port refused, or the connection timed out.
    const cause = (err as {cause?: {code?: string; message?: string}})?.cause
    const why = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))
    throw new FacesAPIError(
      0,
      `Could not reach ${this.baseUrl} (${why}) for ${path}. Check your network connection, and the base URL in: faces config:show`,
    )
  }

  /**
   * One request, retried at most once when the per-minute rate limit refuses it.
   *
   * The limit answers 429 with `Retry-After`, before any work and with nothing
   * charged, so waiting it out and asking again is safe. Agents drive this
   * CLI, and a loop that asks again at once only spends the next minute's
   * requests too, so this waits the server's number exactly, once, and then
   * gives the caller whatever the second answer is. A 429 for a used
   * allowance is not a rate limit: it lasts until the allowance resets, and is
   * passed straight back.
   */
  private async send(path: string, url: string, init: RequestInit): Promise<Response> {
    const once = async (): Promise<Response> => {
      try {
        return await fetch(url, init)
      } catch (err) {
        this.wrapNetworkError(err, path)
      }
    }

    let resp = await once()
    // A saved key outranks the saved login, so once it was revoked every
    // command failed with a 401 while whoami, trying the login, said all was
    // well. Fall back to the login once, and say how to drop the dead key. A
    // key passed for this run was a choice, and gets no fallback.
    const sentKey = this.apiKey && (init.headers as Record<string, string> | undefined)?.Authorization === `Bearer ${this.apiKey}`
    if (resp.status === 401 && sentKey && this.keySaved && this.token) {
      process.stderr.write('warn: the saved API key was refused (revoked or expired), so the saved login was used instead. Remove the key with: faces config:set api_key ""\n')
      this.apiKey = undefined
      init = {...init, headers: {...(init.headers as Record<string, string>), Authorization: `Bearer ${this.token}`}}
      resp = await once()
    }

    // A refusal that a later request outlived is not why a command failed.
    if (resp.ok) this.lastError = undefined
    if (resp.status !== 429) return resp
    const wait = rateLimitWait(parseRetryAfter(resp.headers.get('retry-after')), await resp.clone().text())
    if (wait === undefined) return resp
    process.stderr.write(`Rate limited. Waiting ${wait}s, then asking once more.\n`)
    await new Promise((r) => setTimeout(r, wait * 1000))
    return once()
  }

  private async parseError(resp: Response): Promise<FacesAPIError> {
    let msg = resp.statusText
    let errorCode: string | undefined
    let fallbackAvailable: boolean | undefined
    let details: Record<string, unknown> | undefined
    try {
      const body = await resp.json() as Record<string, unknown>

      // Structured OAuth rejection (422)
      if (body.error === 'oauth_rejected') {
        errorCode = 'oauth_rejected'
        fallbackAvailable = body.fallback_available as boolean | undefined
        msg = String(body.detail ?? 'OAuth request rejected')
      } else {
        // `{error: "<code>", detail: "<sentence>"}` is the OAuth family's
        // shape (oauth_incomplete, oauth_rate_limited, ...). Keep the code, or
        // only the sentence survives and nothing can branch on which it was.
        if (typeof body.error === 'string' && body.detail !== undefined) errorCode = body.error
        // A refusal can also carry its code beside a plain sentence:
        // {detail: "...", error_code: "oauth_only_unavailable"}.
        else if (typeof body.error_code === 'string') errorCode = body.error_code
        let raw = body.detail ?? body.error ?? body.message ?? msg
        // Provider-shaped errors nest one level: {detail: {error: {message,
        // code, param}}}. Unwrap it, or the message somebody wrote for a user
        // is printed at them as a JSON blob with the useful sentence inside.
        if (typeof raw === 'object' && raw !== null) {
          const inner = (raw as Record<string, unknown>).error
          if (typeof inner === 'object' && inner !== null && 'message' in inner) raw = inner
        }
        if (typeof raw === 'object' && raw !== null) {
          // Structured error detail, e.g. {error, message, details}
          const obj = raw as Record<string, unknown>
          details = obj
          // Three spellings in the wild: `error` is our own convention, `code`
          // is the provider-shaped one, and `error_code` is what the compile
          // refusals use.
          if (typeof obj.error === 'string') errorCode = obj.error
          else if (typeof obj.code === 'string') errorCode = obj.code
          else if (typeof obj.error_code === 'string') errorCode = obj.error_code
          msg = 'message' in obj ? String(obj.message) : (readableDetail(obj.detail) ?? JSON.stringify(obj))
        } else {
          msg = String(raw)
        }
      }
    } catch {
      // use statusText
    }

    // The Faces API answers in JSON, even when it refuses. Anything else is
    // some other server, and an "update the CLI" hint would send people the
    // wrong way.
    const type = resp.headers.get('content-type') ?? ''
    if (!type.includes('json')) {
      const origin = new URL(this.baseUrl).origin
      const error = new FacesAPIError(
        resp.status,
        `${origin} did not answer like the Faces API (HTTP ${resp.status}${type ? `, ${type.split(';')[0]}` : ''}). ` +
          `Check the base URL in: faces config:show (the Faces API is ${DEFAULT_API})`,
      )
      this.lastError = error
      return error
    }

    if (resp.status === 402) msg = `Payment required: ${msg}`
    if (resp.status === 403) msg = `Forbidden: ${msg}`
    const guidance = refusalGuidance(resp.status, errorCode, msg)
    if (guidance) msg = `${msg}\n${guidance}`
    else if (looksOutOfDate(resp.status, msg)) {
      // Every route starts with /v1, so a base URL that already ends in a path
      // misses them all, which looks exactly like a route this CLI is too old for.
      const base = new URL(this.baseUrl)
      const basePath = base.pathname.replace(/\/$/, '')
      msg = resp.status === 404 && basePath
        ? `${msg}\nThe base URL ends in ${basePath}, but routes already include it. Use: faces config:set base_url ${base.origin}`
        : `${msg}\n${outOfDateHint(await latestCliVersion())}`
    }
    const error = new FacesAPIError(resp.status, msg, {
      errorCode,
      fallbackAvailable,
      details,
      retryAfter: parseRetryAfter(resp.headers.get('retry-after')),
    })
    this.lastError = error
    return error
  }

  async get(path: string, opts: {requireJwt?: boolean; params?: Record<string, string>; optionalAuth?: boolean} = {}): Promise<unknown> {
    let url = this.url(path)
    if (opts.params && Object.keys(opts.params).length > 0) {
      url += '?' + new URLSearchParams(opts.params).toString()
    }

    // A public route answers without credentials; send them when there are some.
    let auth: Record<string, string> = {}
    if (opts.optionalAuth) {
      try {
        auth = this.authHeader()
      } catch {
        auth = {}
      }
    } else {
      auth = this.authHeader(opts.requireJwt)
    }

    const resp = await this.send(path, url, {headers: {...auth}})

    if (!resp.ok) throw await this.parseError(resp)
    return resp.json()
  }

  /**
   * Every page of a cursor-paginated list route, followed to the end.
   *
   * `/v1/faces` serves a bounded page and reports `has_more` with a
   * `next_cursor`. Reading only the first page silently truncates: the command
   * looks like it succeeded and the rows past the first page simply do not
   * exist as far as the caller can tell, on any account large enough.
   *
   * `truncated` is true only when the loop gave up with pages still
   * outstanding, so a caller can say so rather than present a partial list as
   * complete.
   */
  async getAll(
    path: string,
    opts: {requireJwt?: boolean; pageSize?: number; maxPages?: number} = {},
  ): Promise<{
    data: Array<Record<string, unknown>>
    pages: number
    truncated: boolean
    /** The first page as served, so a caller can read fields that sit beside `data`. */
    envelope: Record<string, unknown>
  }> {
    const maxPages = opts.maxPages ?? 100
    const rows: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    let envelope: Record<string, unknown> = {}

    for (;;) {
      const extra = new URLSearchParams()
      if (opts.pageSize) extra.set('limit', String(opts.pageSize))
      if (cursor) extra.set('cursor', cursor)
      const q = extra.toString()
      const url = q ? (path.includes('?') ? `${path}&${q}` : `${path}?${q}`) : path

      const resp = (await this.get(url, {requireJwt: opts.requireJwt})) as unknown
      pages++

      // A route that never paginated at all just returns the array.
      if (Array.isArray(resp)) {
        return {data: resp as Array<Record<string, unknown>>, pages, truncated: false, envelope: {}}
      }

      const env = (resp ?? {}) as {data?: unknown; has_more?: unknown; next_cursor?: unknown}
      // A list is an array or {data: [...]}. Anything else is some other
      // server answering 200, which read as an empty list: "(no faces)".
      if (!Array.isArray(env.data)) {
        throw new FacesAPIError(502, `${new URL(this.baseUrl).origin} did not answer like the Faces API: ${path} returned no list. Check the base URL in: faces config:show`)
      }

      if (pages === 1) envelope = env as Record<string, unknown>
      if (Array.isArray(env.data)) rows.push(...(env.data as Array<Record<string, unknown>>))

      const next = typeof env.next_cursor === 'string' && env.next_cursor !== '' ? env.next_cursor : undefined
      if (env.has_more !== true || !next) return {data: rows, pages, truncated: false, envelope}

      // A cursor that repeats, or a server that never stops claiming more, must
      // not spin this loop forever.
      if (seen.has(next) || pages >= maxPages) return {data: rows, pages, truncated: true, envelope}
      seen.add(next)
      cursor = next
    }
  }

  async post(path: string, opts: {requireJwt?: boolean; body?: unknown} = {}): Promise<unknown> {
    const resp = await this.send(path, this.url(path), {
      method: 'POST',
      headers: {...this.authHeader(opts.requireJwt), 'Content-Type': 'application/json'},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!resp.ok) throw await this.parseError(resp)
    return resp.json()
  }

  async postWithHeaders(path: string, opts: {requireJwt?: boolean; body?: unknown} = {}): Promise<ResponseWithHeaders> {
    const resp = await this.send(path, this.url(path), {
      method: 'POST',
      headers: {...this.authHeader(opts.requireJwt), 'Content-Type': 'application/json'},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!resp.ok) throw await this.parseError(resp)
    const headers: Record<string, string> = {}
    for (const [k, v] of resp.headers.entries()) headers[k] = v
    const data = await resp.json()
    return {data, headers}
  }

  async postNoAuth(path: string, body: unknown): Promise<unknown> {
    const resp = await this.send(path, this.url(path), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    })

    if (!resp.ok) throw await this.parseError(resp)
    return resp.json()
  }

  async put(path: string, opts: {requireJwt?: boolean; body?: unknown} = {}): Promise<unknown> {
    const resp = await this.send(path, this.url(path), {
      method: 'PUT',
      headers: {...this.authHeader(opts.requireJwt), 'Content-Type': 'application/json'},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!resp.ok) throw await this.parseError(resp)
    return resp.json()
  }

  async patch(path: string, opts: {requireJwt?: boolean; body?: unknown} = {}): Promise<unknown> {
    const resp = await this.send(path, this.url(path), {
      method: 'PATCH',
      headers: {...this.authHeader(opts.requireJwt), 'Content-Type': 'application/json'},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!resp.ok) throw await this.parseError(resp)
    return resp.json()
  }

  async delete(path: string, opts: {requireJwt?: boolean} = {}): Promise<unknown> {
    const resp = await this.send(path, this.url(path), {
      method: 'DELETE',
      headers: {...this.authHeader(opts.requireJwt)},
    })

    if (!resp.ok) throw await this.parseError(resp)
    // DELETE may return 204 with no body
    const text = await resp.text()
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  /**
   * A route that answers with bytes rather than JSON.
   *
   * The avatar image route serves png or svg and puts what you actually got
   * into response headers: which version, whether it is stale, organic or the
   * owner's uploaded picture. A caller that only kept the body could not tell
   * a current avatar from a stale one, so the headers come back too.
   */
  async getBinary(
    path: string,
    opts: {requireJwt?: boolean} = {},
  ): Promise<{bytes: Uint8Array; contentType: string; headers: Record<string, string>}> {
    const resp = await this.send(path, this.url(path), {headers: {...this.authHeader(opts.requireJwt)}})

    if (!resp.ok) throw await this.parseError(resp)

    const headers: Record<string, string> = {}
    for (const [k, v] of resp.headers.entries()) headers[k.toLowerCase()] = v

    return {
      bytes: new Uint8Array(await resp.arrayBuffer()),
      contentType: resp.headers.get('content-type') ?? 'application/octet-stream',
      headers,
    }
  }

  async putForm(path: string, formData: FormData, opts: {requireJwt?: boolean} = {}): Promise<unknown> {
    const resp = await this.send(path, this.url(path), {
      method: 'PUT',
      headers: {...this.authHeader(opts.requireJwt)},
      body: formData,
    })

    if (!resp.ok) throw await this.parseError(resp)
    return resp.json()
  }

  async postForm(path: string, formData: FormData, opts: {requireJwt?: boolean} = {}): Promise<unknown> {
    const resp = await this.send(path, this.url(path), {
      method: 'POST',
      headers: {...this.authHeader(opts.requireJwt)},
      body: formData,
    })

    if (!resp.ok) throw await this.parseError(resp)
    return resp.json()
  }

  /**
   * POST and read the reply as server-sent events, yielding each `data:` line
   * (and `event:` lines) as it arrives.
   *
   * Two things a hand-written reader has to do that the SDKs do for us:
   *   - skip comment lines. While a face's cause takes long, the server
   *     holds the stream open with `: keep-alive` every 10s until the answer
   *     begins.
   *   - treat an error event as a failure. Once the 200 has gone, a refusal
   *     can only arrive inside the stream; it is thrown here as a
   *     FacesAPIError so every consumer stops and says so.
   *
   * `onHeaders` sees the response headers before the first line.
   */
  async *stream(
    path: string,
    body: unknown,
    opts: {requireJwt?: boolean; onHeaders?: (headers: Record<string, string>) => void} = {},
  ): AsyncGenerator<string> {
    const resp = await this.send(path, this.url(path), {
      method: 'POST',
      headers: {...this.authHeader(opts.requireJwt), 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    })

    if (!resp.ok || !resp.body) {
      throw await this.parseError(resp)
    }

    if (opts.onHeaders) {
      const headers: Record<string, string> = {}
      for (const [k, v] of resp.headers.entries()) headers[k.toLowerCase()] = v
      opts.onHeaders(headers)
    }

    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    // A model's refusal can come back as a bare JSON body under a 200 and an
    // event-stream type, with no SSE fields at all. Read line by line it is
    // nothing, and the command printed an empty reply and exited 0.
    let sawEvent = false
    let bare = ''
    const take = (raw: string): string | undefined => {
      const line = raw.replace(/\r$/, '')
      if (!line.trim() || line.startsWith(':')) return undefined
      if (/^(data|event|id|retry):/.test(line)) sawEvent = true
      else if (!sawEvent) bare += line + '\n'
      if (line.startsWith('data:')) {
        const err = streamErrorOf(line.slice(5).trim())
        if (err) throw err
      }
      return line
    }
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      buf += dec.decode(value, {stream: true})
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        const line = take(raw)
        if (line !== undefined) yield line
      }
    }

    const last = take(buf)
    if (last !== undefined) yield last
    if (!sawEvent && bare.trim()) {
      throw streamErrorOf(bare) ?? new FacesAPIError(502, `The server sent a stream with no events in it: ${bare.trim().slice(0, 200)}`)
    }
  }
}

/** Anthropic's error types, as the HTTP status each stands for. */
const ANTHROPIC_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 503,
}

/**
 * The refusal in one SSE `data:` payload, or undefined when it is not one.
 *
 * Each endpoint sends a late refusal in its own family's shape:
 *   - Chat Completions: `{"error": {"message", "code": 503}}`, then `[DONE]`
 *   - Responses: `{"type": "error", "code": "503", "message"}`
 *   - Messages: `{"type": "error", "error": {"type": "overloaded_error", "message"}}`
 * A status the payload does not name is taken as 503, the retry signal.
 */
export function streamErrorOf(data: string): FacesAPIError | undefined {
  if (!data.includes('error')) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined

  const status = (code: unknown): number => {
    const n = Number(code)
    return Number.isInteger(n) && n >= 400 && n < 600 ? n : 503
  }
  // An explicit `status`, when the event carries one, is the real status.
  const statusOf = (s: unknown): number | undefined => {
    const n = Number(s)
    return s !== undefined && s !== null && Number.isInteger(n) && n >= 400 && n < 600 ? n : undefined
  }
  const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
  // A refusal with a code of its own sends that code in place of the status.
  const named = (code: unknown): string | undefined =>
    typeof code === 'string' && code !== '' && !/^\d+$/.test(code) ? code : undefined

  if (parsed.type === 'error') {
    const inner = parsed.error as Record<string, unknown> | undefined
    if (inner && typeof inner === 'object') {
      const type = typeof inner.type === 'string' ? inner.type : undefined
      return new FacesAPIError(
        statusOf(inner.status) ?? ((type && ANTHROPIC_ERROR_STATUS[type]) || 503),
        String(inner.message ?? type ?? 'The stream ended with an error.'),
        {errorCode: named(inner.code) ?? type, retryable: flag(inner.retryable)},
      )
    }
    return new FacesAPIError(statusOf(parsed.status) ?? status(parsed.code), String(parsed.message ?? 'The stream ended with an error.'), {
      errorCode: named(parsed.code),
      retryable: flag(parsed.retryable),
    })
  }

  const inner = parsed.error as Record<string, unknown> | undefined
  if (inner && typeof inner === 'object' && !parsed.choices) {
    // OpenAI names the kind in `type` and often leaves `code` null; a bad
    // parameter is the caller's to fix, not a 503 to retry.
    const byType = typeof inner.type === 'string' ? ANTHROPIC_ERROR_STATUS[inner.type] : undefined
    const code = Number(inner.code)
    return new FacesAPIError(statusOf(inner.status) ?? (Number.isInteger(code) && code >= 400 && code < 600 ? code : byType ?? 503), String(inner.message ?? 'The stream ended with an error.'), {
      errorCode: named(inner.code) ?? (typeof inner.type === 'string' ? inner.type : undefined),
      retryable: flag(inner.retryable),
    })
  }
  return undefined
}

/**
 * The refusal inside a held chat response, or undefined when the body is an
 * answer.
 *
 * A face chat that is not streamed and runs past about 40 seconds is held
 * open: the server sends 200 at once with `X-Faces-Held: 1`, keeps the
 * connection alive with spaces, and writes the JSON when it is done. A JSON
 * parser skips the spaces. A refusal after that point arrives as the body,
 * with the real status in `error.status`:
 *   - Chat Completions and Responses: `{detail, error: {message, type, code, status}}`
 *   - Messages: `{type: "error", detail, error: {type, message, status}}`
 * A body that is an answer in any of the three shapes is never read as one.
 */
export function heldChatError(data: unknown): FacesAPIError | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const d = data as Record<string, unknown>
  if (!d.error || typeof d.error !== 'object') return undefined
  // An answer: Chat Completions, Responses, or Messages.
  if ('choices' in d || 'output' in d || d.object === 'response' || d.object === 'chat.completion') return undefined
  if (d.type === 'message' || 'content' in d) return undefined
  const e = d.error as Record<string, unknown>
  const n = Number(e.status)
  const status = Number.isInteger(n) && n >= 400 && n < 600 ? n : 502
  const said =
    readableDetail(d.detail) ?? (typeof e.message === 'string' && e.message.trim() ? e.message : undefined)
  // `code` repeats the status as text; a named code or the type says more.
  const code =
    typeof e.code === 'string' && !/^\d+$/.test(e.code) ? e.code : typeof e.type === 'string' ? e.type : undefined
  return new FacesAPIError(status, said ?? 'The request failed after the server held it open.', {
    errorCode: code,
    retryable: typeof e.retryable === 'boolean' ? e.retryable : undefined,
  })
}
