import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {BUILDS_PATH, EXIT_NO_SUCH_FACE, chatgptLinked, formatBuildReport, jobFailureMessage, faceExists, jobMedium, pollStyleJob, publicJob} from '../../style.js'

export default class StyleStatus extends BaseCommand {
  static description =
    'Read a style build. Give a job id for one build, or --face to list a face\'s recent builds. ' +
    'Listing is how you find a job id you no longer have.'

  static examples = [
    '<%= config.bin %> <%= command.id %> 7a8b9c0d',
    '<%= config.bin %> <%= command.id %> --face alice',
    '<%= config.bin %> <%= command.id %> 7a8b9c0d --wait',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    face: Flags.string({description: 'List recent builds for this face instead of reading one job'}),
    limit: Flags.integer({description: 'How many builds to list with --face (1-100, default: 10)', default: 10, min: 1, max: 100}),
    wait: Flags.boolean({description: 'Block until the job finishes', default: false}),
    timeout: Flags.integer({description: 'How long to wait with --wait, in seconds', default: 3600}),
  }

  static args = {
    job_id: Args.string({description: 'Build job id', required: false}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StyleStatus)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (!args.job_id && !flags.face) {
      this.error('Give a job id, or --face <alias> to list a face\'s builds.')
    }
    if (args.job_id && flags.face) {
      this.error('Pass either a job id or --face, not both.')
    }

    if (flags.face) return this.list(client, flags.face, flags.limit, json)

    let data: Record<string, unknown>
    try {
      data = flags.wait
        ? await pollStyleJob(client, BUILDS_PATH, args.job_id!, {timeoutMs: flags.timeout * 1000})
        : ((await client.get(`${BUILDS_PATH}/${encodeURIComponent(args.job_id!)}`)) as Record<string, unknown>)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No build job '${args.job_id}'. List a face's builds with --face <alias>.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    // A failed job is not a successful wait: scripts and agents read the exit
    // code, and 0 read as a built style.
    if (data.status === 'failed') process.exitCode = 1
    if (json) return publicJob(data)
    for (const line of formatBuildReport(data)) this.log(line)
    if (data.status === 'failed') this.log(`\nerror:      ${jobFailureMessage(data.error, await chatgptLinked(client), data.error_code)}`)
    return data
  }

  private async list(
    client: ReturnType<typeof this.makeClient>,
    face: string,
    limit: number,
    json: boolean,
  ): Promise<unknown> {
    let data: Record<string, unknown>
    try {
      data = (await client.get(
        `${BUILDS_PATH}?self_face=${encodeURIComponent(face)}&limit=${limit}`,
      )) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No face named '${face}'. It does not exist, or is not yours.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    const jobs = (data.jobs as Array<Record<string, unknown>>) ?? []
    // An empty list comes back for an unknown face too. "No builds yet" and
    // "no such face" are opposite answers, so they must not share an output.
    if (jobs.length === 0 && !(await faceExists(client, face))) {
      this.error(`No face named '${face}'. It does not exist, or is not yours.`, {exit: EXIT_NO_SUCH_FACE})
    }
    if (json) return {...data, jobs: jobs.map((j) => publicJob(j))}

    if (jobs.length === 0) {
      this.log(`'${face}' has no style builds yet. Build one with: faces style:make ${face} --all`)
      return data
    }

    const rows = jobs.map((j) => ({
      job: String(j.job_id ?? '-'),
      status: String(j.status ?? '-'),
      // A build can be started from anywhere, so a row that does not name its
      // medium is an unnamed thing in progress. Jobs from before this was
      // stamped have neither field and show a dash.
      medium: jobMedium(j) ?? '-',
      when: String(j.created_at ?? '').slice(0, 19).replace('T', ' ') || '-',
      // Automatic style builds install without anyone asking, so the list is where
      // somebody finds out a style changed on its own. Last column, so a
      // reader of the columns before it is undisturbed.
      by: (j.report as Record<string, unknown> | null | undefined)?.auto ? 'auto' : 'manual',
    }))
    const cols: Array<[string, (r: (typeof rows)[0]) => string]> = [
      ['JOB', (r) => r.job],
      ['STATUS', (r) => r.status],
      ['MEDIUM', (r) => r.medium],
      ['STARTED', (r) => r.when],
      ['BY', (r) => r.by],
    ]
    const w = cols.map(([h, g]) => Math.max(h.length, ...rows.map((r) => g(r).length)))
    const line = (c: string[]) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd()
    this.log(line(cols.map(([h]) => h)))
    for (const r of rows) this.log(line(cols.map(([, g]) => g(r))))
    this.log('')
    this.log(`${rows.length} build(s) shown, newest first. Raise the cap with --limit.`)
    if (rows.some((r) => r.by === 'auto')) {
      this.log('BY auto means an automatic build: it ran once the face had enough of its own writing. Read one')
      this.log('for why, or turn them off: faces account:preferences auto_style off')
    }
    return data
  }
}
