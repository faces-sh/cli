import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {compileProgressLabel} from '../../utils.js'

/** One source the server is working on, inside a face's group. */
interface ActivitySource {
  id: string
  kind?: string | null
  label?: string | null
  status?: string | null
  progress?: number | null
  stall_reason?: string | null
}

interface ActivityFace {
  alias: string
  sources_active?: number | null
  /** Null while the face cannot be measured; `measurable` says so. */
  progress?: number | null
  measurable?: boolean | null
  sources?: ActivitySource[] | null
}

/** A paused source. It holds until resumed, so it is listed apart from the work in flight. */
interface PausedSource extends ActivitySource {
  alias: string
}

interface Activity {
  faces?: ActivityFace[] | null
  paused?: PausedSource[] | null
  faces_active?: number | null
  sources_active?: number | null
  progress?: number | null
  measurable?: boolean | null
}

const ACTIVITY_PATH = '/v1/compile/activity'

/**
 * A face's or the account's progress. When every source in it is queued the
 * group's progress is 0, and "0%" would read as stuck rather than waiting.
 */
function groupLabel(g: {progress?: number | null; measurable?: boolean | null}, sources: ActivitySource[]): string {
  if (sources.length > 0 && sources.every((s) => s.status === 'queued')) return 'queued'
  return compileProgressLabel(g)
}

/** What resumes a paused source: make again, on its kind of source. */
function resumeCommand(s: PausedSource): string {
  return `faces compile:${s.kind === 'document' ? 'doc' : 'thread'}:make ${s.id}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default class CompileStatus extends BaseCommand {
  static description =
    'What is compiling on this account right now, grouped by face. One small request covers every ' +
    'source in flight, which is the question a resumed session cannot answer from memory, and lists ' +
    'paused sources apart, since they wait for you. For this ' +
    'month\'s compile usage against your allowance, that is compile:stats.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --watch',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    watch: Flags.boolean({
      description: 'Keep polling until nothing is in flight, then exit.',
      default: false,
    }),
    interval: Flags.integer({
      description: 'Seconds between polls with --watch (1-60).',
      default: 3,
      min: 1,
      max: 60,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CompileStatus)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    let data = await this.fetch(client)

    if (flags.watch && !json) {
      // Poll until the account is quiet. Each tick is one small request for
      // every source at once, rather than one request per source.
      // Paused sources are not counted as active, so they never keep this going.
      while ((data.sources_active ?? 0) > 0) {
        this.printHumanActivity(data)
        this.log('')
        await sleep(flags.interval * 1000)
        data = await this.fetch(client)
      }
    } else if (flags.watch && json) {
      while ((data.sources_active ?? 0) > 0) {
        await sleep(flags.interval * 1000)
        data = await this.fetch(client)
      }
    }

    if (!json) this.printHumanActivity(data)
    return data
  }

  private async fetch(client: ReturnType<BaseCommand['makeClient']>): Promise<Activity> {
    try {
      return (await client.get(ACTIVITY_PATH)) as Activity
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }
  }

  private printHumanActivity(data: Activity): void {
    // sources_active is read first on purpose: `measurable` is false on an idle
    // account, which is neither true nor useful.
    const active = data.sources_active ?? 0
    if (active === 0) {
      this.log('Nothing is compiling.')
      if (data.paused?.length) this.log('')
      this.printPaused(data.paused ?? [])
      return
    }

    const faces = data.faces ?? []
    this.log(`${active} source(s) compiling across ${data.faces_active ?? faces.length} face(s)`)
    this.log(`  ${groupLabel(data, faces.flatMap((f) => f.sources ?? []))}`)
    this.log('')

    for (const face of faces) {
      this.log(`${face.alias}  (${face.sources_active ?? face.sources?.length ?? 0} source(s), ${groupLabel(face, face.sources ?? [])})`)
      for (const s of face.sources ?? []) {
        const kind = s.kind ?? '-'
        const label = s.label ?? s.id
        this.log(`  ${kind.padEnd(8)} ${label}`)
        this.log(`         ${compileProgressLabel({...s, status: s.status ?? 'compiling'})}`)
        // A stalled source is in here and is being retried, so this is
        // information rather than something to act on.
        if (s.stall_reason) this.log(`         stopped once: ${s.stall_reason} (being retried)`)
      }
      this.log('')
    }

    this.printPaused(data.paused ?? [])
  }

  private printPaused(paused: PausedSource[]): void {
    if (paused.length === 0) return
    this.log(`${paused.length} paused source(s), waiting for you to resume:`)
    for (const s of paused) {
      this.log(`  ${s.alias}  ${(s.kind ?? '-').padEnd(8)} ${s.label ?? s.id}`)
      this.log(`         ${compileProgressLabel({...s, status: s.status ?? 'paused'})}`)
      this.log(`         resume: ${resumeCommand(s)}`)
    }
  }
}
