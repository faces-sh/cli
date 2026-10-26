import {createInterface} from 'node:readline'
import {Command, Flags, ux} from '@oclif/core'
import {encode as encodeToon} from '@toon-format/toon'
import {FacesAPIError, FacesClient} from './client.js'
import {resolveBaseUrl, resolveCredentials} from './config.js'
import {compileFieldLine} from './utils.js'

export abstract class BaseCommand extends Command {
  static enableJsonFlag = true

  static baseFlags = {
    'base-url': Flags.string({
      description: 'API base URL',
      env: 'FACES_BASE_URL',
    }),
    token: Flags.string({
      description: 'JWT bearer token',
      env: 'FACES_TOKEN',
    }),
    'api-key': Flags.string({
      description: 'API key',
      env: 'FACES_API_KEY',
    }),
    toon: Flags.boolean({
      description:
        'Format output as TOON instead of JSON: the same data and field names in a more compact ' +
        'encoding, for agents that pay for their input. Measured across this CLI it is about 40% fewer ' +
        'tokens than --json.',
      default: false,
      exclusive: ['json'],
    }),
  }

  /**
   * Whether the caller asked for TOON.
   *
   * Read off argv the same way oclif reads --json, because both are needed
   * before flags are parsed: the decision to emit structured output at all is
   * made before run(), and an error thrown during parsing still has to be
   * reported in the format that was asked for.
   */
  protected toonEnabled(): boolean {
    const passThrough = this.argv.indexOf('--')
    const i = this.argv.indexOf('--toon')
    if (i === -1) return false
    // Both given is refused as a flag error, and that refusal has to be JSON.
    if (this.argv.includes('--json')) return false
    return passThrough === -1 || i < passThrough
  }

  // --toon takes the same path as --json through oclif; only the encoding at
  // the end differs, so there is one shape to maintain rather than two.
  jsonEnabled(): boolean {
    return this.toonEnabled() || super.jsonEnabled()
  }

  logJson(json: unknown): void {
    if (this.toonEnabled()) {
      ux.stdout(encodeToon(json as Parameters<typeof encodeToon>[0]))
      return
    }
    super.logJson(json)
  }

  protected makeClient(
    flags: {'base-url'?: string; token?: string; 'api-key'?: string},
    _requireJwt = false,
  ): FacesClient {
    const baseUrl = resolveBaseUrl(flags['base-url'])
    const {token, apiKey, withheld, keySaved} = resolveCredentials(flags, baseUrl)
    this.apiClient = new FacesClient(baseUrl, token, apiKey, withheld, keySaved)
    return this.apiClient
  }

  private apiClient?: FacesClient

  async catch(err: Error & {exitCode?: number}): Promise<unknown> {
    // When --json is enabled, oclif swallows error messages. Override to
    // include the message in structured JSON output so agents can parse it.
    if (this.jsonEnabled()) {
      // The exit code oclif gives this error in text mode, so a script sees
      // the same code either way.
      const code = (err as {oclif?: {exit?: number}}).oclif?.exit ?? err.exitCode ?? 1
      const error: Record<string, unknown> = {message: err.message, code}
      // Most commands re-raise a refusal as text, often reworded. Put back what
      // an agent branches on when the last request was refused.
      const api = err instanceof FacesAPIError ? err : this.apiClient?.lastError
      if (api) {
        error.status = api.statusCode
        if (api.errorCode) error.error_code = api.errorCode
        if (api.fallbackAvailable !== undefined) error.fallback_available = api.fallbackAvailable
        if (api.retryAfter !== undefined) error.retry_after = api.retryAfter
        // What a rush would add, when there is not enough credit for it.
        if (typeof api.details?.rush_premium_usd === 'number') error.rush_premium_usd = api.details.rush_premium_usd
        // What a style build is estimated at, and the balance, when credit cannot cover it.
        if (typeof api.details?.estimated_usd === 'number') error.estimated_usd = api.details.estimated_usd
        if (typeof api.details?.balance_usd === 'number') error.balance_usd = api.details.balance_usd
      }

      const payload = {error}
      process.stdout.write(
        (this.toonEnabled() ? encodeToon(payload) : JSON.stringify(payload)) + '\n',
      )
      process.exit(code)
    }
    throw err
  }

  /**
   * Ask before something that cannot be taken back, or refuse.
   *
   * Without a terminal nobody can answer, and readline then leaves oclif on a
   * promise that never settles: exit 13 with the prompt in stdout. --json is
   * how an agent asks, and it must not double as --yes either; it once let a
   * plan switch charge a card unasked. The prompt goes to stderr so stdout
   * stays the command's output.
   */
  protected async confirmOrRefuse(message: string, yes: boolean): Promise<void> {
    if (yes) return
    if (this.jsonEnabled() || !process.stdin.isTTY) {
      this.error(`${message}\nRe-run with --yes to confirm. Nothing was changed.`)
    }

    const answer = await new Promise<string>((resolve) => {
      const rl = createInterface({input: process.stdin, output: process.stderr})
      rl.question(`${message} [y/N] `, (a) => {
        rl.close()
        resolve(a)
      })
    })
    if (answer.trim().toLowerCase() !== 'y') this.error('Aborted. Nothing was changed.')
  }

  /**
   * A secret from the flag, or typed at a hidden prompt when the flag is left out.
   *
   * The prompt only runs on a terminal: without one nobody can type, so the
   * flag is required. Nothing typed is echoed, and the prompt goes to stderr so
   * stdout stays the command's output.
   */
  protected async secretOrPrompt(value: string | undefined, flag: string, label: string): Promise<string> {
    if (value !== undefined) return value
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      this.error(`--${flag} is required when not running in a terminal.`)
    }

    const typed = await new Promise<string | null>((resolve) => {
      const stdin = process.stdin
      let buf = ''
      process.stderr.write(`${label}: `)
      stdin.setRawMode(true)
      stdin.resume()
      stdin.setEncoding('utf8')
      const done = (result: string | null) => {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.removeListener('data', onData)
        process.stderr.write('\n')
        resolve(result)
      }

      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(buf)
          if (ch === '\u0003') return done(null)
          if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
          else if (ch >= ' ') buf += ch
        }
      }

      stdin.on('data', onData)
    })
    if (typed === null) this.error('Aborted.')
    if (typed === '') this.error(`No ${label.toLowerCase()} entered.`)
    return typed
  }

  protected printHuman(data: unknown, indent = 0): void {
    const prefix = '  '.repeat(indent)
    if (Array.isArray(data)) {
      if (data.length === 0) {
        this.log(`${prefix}(empty)`)
        return
      }

      // An array of plain values reads as one line. Six numbers down six rows
      // is the kind of output people stop reading.
      if (data.every((v) => v === null || typeof v !== 'object')) {
        this.log(`${prefix}[${data.map((v) => String(v)).join(', ')}]`)
        return
      }

      for (const [i, item] of data.entries()) {
        this.log(`${prefix}[${i}]`)
        this.printHuman(item, indent + 1)
      }
    } else if (data !== null && typeof data === 'object') {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        // read_only: only surface when set; render as a bare marker, never "read_only: false"
        if (k === 'read_only') {
          if (v) this.log(`${prefix}read only`)
          continue
        }

        // A compile's allowance, start time and rush read in words: 0 and -1
        // are not counts, and a null start is the ordinary case.
        const line = compileFieldLine(k, v)
        if (line === null) continue
        if (line !== undefined) {
          this.log(`${prefix}${line}`)
          continue
        }

        if (v !== null && typeof v === 'object') {
          this.log(`${prefix}${k}:`)
          this.printHuman(v, indent + 1)
        } else {
          this.log(`${prefix}${k}: ${v}`)
        }
      }
    } else {
      this.log(`${prefix}${data}`)
    }
  }
}
