import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {compileBlockedLabel, compileProgressLabel, compileStatusOf, freshnessOf, revisionsBehind} from '../../utils.js'

/** Exit code for "no such face", so a caller can tell it from an empty face. */
const EXIT_NO_SUCH_FACE = 4

interface RawSource {
  document_id?: string
  thread_id?: string
  label?: string | null
  token_count?: number | null
  user_token_count?: number | null
  message_count?: number | null
  medium?: string | null
  /** Threads only: what an imported corpus arrived as. `medium` overrides it. */
  corpus_medium?: string | null
  perspective?: string | null
  synced?: boolean | null
  /** queued, compiling, compiled, paused, failed, not_compiled or transcribing. */
  status?: string | null
  /** 0 to 1. */
  progress?: number | null
  /** The scheduled start, or once started when it started; null when it starts at once. */
  starts_at?: string | null
  /** Queued as a rush. */
  rush?: boolean | null
  updated_at?: string | null
  created_at?: string | null
  read_only?: boolean | null
  /** True while the server is working on it, including an automatic retry. */
  finishing?: boolean | null
  /** The source's current revision, and the one its compile read. */
  version?: number | null
  synced_version?: number | null
  synced_at?: string | null
  /** False when the server would refuse a compile, with the reason beside it. */
  compilable?: boolean | null
  compile_blocked_reason?: string | null
  source?: string | null
}

interface Row {
  type: 'doc' | 'thread'
  id: string
  label: string
  tokens: number
  status: string
  medium: string
  updated: string
  synced: boolean
  /** The server is still working on it; the caller should offer no action. */
  finishing: boolean
}

export default class FaceSources extends BaseCommand {
  static description =
    'List every source compiled into a face: documents and threads together, one row each. ' +
    `Exits ${EXIT_NO_SUCH_FACE} if the face does not exist, which is a different answer from a face that ` +
    'has no sources. Content is never printed; read a single source with compile:doc:get or compile:thread:get.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice',
    '<%= config.bin %> <%= command.id %> alice --type thread',
    '<%= config.bin %> <%= command.id %> alice --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    type: Flags.string({description: 'Show only one kind of source', options: ['doc', 'thread']}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceSources)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    const alias = encodeURIComponent(args.alias)

    const wantDocs = flags.type !== 'thread'
    const wantThreads = flags.type !== 'doc'

    // A face that does not exist and a face with nothing in it are opposite
    // answers. The API distinguishes them with a 404, so this must too: by
    // message and by exit code, since a script only sees the latter.
    const docs = wantDocs ? await this.fetch(client, `/v1/compile/documents?alias=${alias}`, args.alias) : []
    // include_uploads defaults to excluding upload-created threads. This command
    // claims to list every source, so it asks for them explicitly.
    const threads = wantThreads
      ? await this.fetch(client, `/v1/compile/threads?alias=${alias}&include_uploads=true`, args.alias)
      : []

    const rows = [...docs.map((d) => this.toRow(d, 'doc')), ...threads.map((t) => this.toRow(t, 'thread'))]
    rows.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.label.localeCompare(b.label))

    if (json) {
      return {
        alias: args.alias,
        documents: docs.map((d) => this.toJson(d, 'doc')),
        threads: threads.map((t) => this.toJson(t, 'thread')),
        totals: {
          sources: rows.length,
          tokens: rows.reduce((n, r) => n + r.tokens, 0),
          not_synced: rows.filter((r) => !r.synced).length,
        },
      }
    }

    this.render(args.alias, rows, flags.type)
    return {alias: args.alias, sources: rows.length}
  }

  private async fetch(
    client: ReturnType<typeof this.makeClient>,
    path: string,
    alias: string,
  ): Promise<RawSource[]> {
    try {
      const data = await client.get(path)
      return (Array.isArray(data) ? data : ((data as {data?: RawSource[]}).data ?? [])) as RawSource[]
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) {
          this.error(`No face named '${alias}'. It does not exist, or is not owned by this account.`, {
            exit: EXIT_NO_SUCH_FACE,
          })
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }
  }

  private statusOf(s: RawSource): string {
    // Branch on `finishing` first and read the status only after it. A source the server is retrying on its own
    // can report a failure, which reads as an error needing a hand; rendering
    // it that way tells someone to do what the server is already doing and
    // invites a second charge for work in flight. Queued is in here too.
    if (s.finishing) {
      const st = compileStatusOf(s.status)
      return compileProgressLabel({...s, status: st === 'failed' || st === null ? 'compiling' : st})
    }

    // A row reading "synced" while the text has been rewritten since is the
    // thing the revision fields exist to end. Only the known-stale case is
    // called out: a source compiled before revisions were recorded reads
    // unknown, not stale, and that is most of them on an older account, so
    // marking those would be noise rather than information.
    if (s.synced) {
      const behind = revisionsBehind(s)
      // "compiled", the word every other command uses for this.
      return behind === null ? 'compiled' : `stale (${behind} behind)`
    }

    // Not compiled covers two different answers: not yet, and never, because
    // the server will refuse it. Offering the second as though it were the
    // first is what sends someone to run a compile that cannot work.
    if (s.compilable === false) {
      const why = compileBlockedLabel(s.compile_blocked_reason) || 'refused'
      return `cannot compile: ${why}`
    }

    const st = compileStatusOf(s.status)
    if (st && st !== 'compiled') return compileProgressLabel(s)
    return 'not compiled'
  }

  private toRow(s: RawSource, type: 'doc' | 'thread'): Row {
    return {
      type,
      id: String(s.document_id ?? s.thread_id ?? ''),
      label: s.label?.trim() || '(untitled)',
      tokens: s.token_count ?? 0,
      status: this.statusOf(s),
      // A thread carries a correction and a derived value; the correction wins,
      // which is the order a style build resolves in.
      medium: s.medium?.trim() || s.corpus_medium?.trim() || '-',
      updated: (s.updated_at ?? s.created_at ?? '').slice(0, 10) || '-',
      synced: Boolean(s.synced),
      finishing: Boolean(s.finishing),
    }
  }

  private toJson(s: RawSource, type: 'doc' | 'thread'): Record<string, unknown> {
    const out: Record<string, unknown> = {
      type,
      // A stable id, because anything that later deletes or recompiles a source
      // needs one: the label is for people and is not unique.
      id: String(s.document_id ?? s.thread_id ?? ''),
      label: s.label ?? null,
      token_count: s.token_count ?? 0,
      status: this.statusOf(s),
      synced: Boolean(s.synced),
      // The server's own state, beside `status` which is the reading above.
      compile_status: compileStatusOf(s.status),
      progress: s.progress ?? null,
      starts_at: s.starts_at ?? null,
      rush: s.rush ?? false,
      finishing: Boolean(s.finishing),
      version: s.version ?? null,
      synced_version: s.synced_version ?? null,
      synced_at: s.synced_at ?? null,
      freshness: freshnessOf(s),
      revisions_behind: revisionsBehind(s),
      compilable: s.compilable ?? null,
      compile_blocked_reason: s.compile_blocked_reason ?? null,
      medium: s.medium ?? s.corpus_medium ?? null,
      corpus_medium: s.corpus_medium ?? null,
      // Documents only. Third-person material is ABOUT the subject rather than
      // written by them, so it is compiled but builds no style, and a style
      // build naming only such sources is refused.
      perspective: s.perspective ?? null,
      created_at: s.created_at ?? null,
      updated_at: s.updated_at ?? null,
      read_only: Boolean(s.read_only),
    }
    if (type === 'doc') out.document_id = s.document_id
    if (type === 'thread') {
      out.thread_id = s.thread_id
      out.message_count = s.message_count ?? null
    }
    return out
  }

  private render(alias: string, rows: Row[], type?: string): void {
    if (rows.length === 0) {
      const what = type ? `${type} sources` : 'sources'
      this.log(`'${alias}' exists and has no ${what}.`)
      return
    }

    const n = (v: number) => v.toLocaleString('en-US')
    const cols: Array<[string, (r: Row) => string]> = [
      ['TYPE', (r) => r.type],
      ['LABEL', (r) => r.label],
      ['TOKENS', (r) => n(r.tokens)],
      ['STATUS', (r) => r.status],
      ['MEDIUM', (r) => r.medium],
      ['UPDATED', (r) => r.updated],
      // Every action on a row takes its id, which no column showed.
      ['ID', (r) => r.id],
    ]
    const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)))
    const line = (cells: string[]) =>
      cells
        .map((c, i) => (cols[i][0] === 'TOKENS' ? c.padStart(widths[i]) : c.padEnd(widths[i])))
        .join('  ')
        .trimEnd()

    this.log(line(cols.map(([h]) => h)))
    for (const r of rows) this.log(line(cols.map(([, get]) => get(r))))

    // Say what the total counts. Every listed row is included, so the column
    // adds up to the figure shown; anything not yet compiled is called out
    // separately rather than quietly left out of the sum.
    const tokens = rows.reduce((a, r) => a + r.tokens, 0)
    // "Not synced" covers two situations a reader has to act on differently:
    // one the server is still handling, and one waiting on them.
    const working = rows.filter((r) => r.finishing).length
    const stopped = rows.filter((r) => !r.synced && !r.finishing).length
    this.log('')
    this.log(`${n(tokens)} tokens across all ${rows.length} source(s) listed.`)
    if (working > 0) {
      this.log(`${working} still being worked on by the server. They need no action and will finish on their own.`)
    }
    if (stopped > 0) {
      this.log(`${stopped} not compiled and not running. Their tokens are included in that total.`)
    }
  }
}
