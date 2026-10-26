import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {pollCompileProgress, PollProgress, progressLine} from '../../../poll.js'
import {compileStatusOf, makeRefusalMessage, makeScheduleLines, msUntilStart, RUSH_FLAG_DESCRIPTION, seg} from '../../../utils.js'

export default class CompileThreadMake extends BaseCommand {
  static description =
    'Compile an existing thread and wait for it to finish. A compile may have a scheduled start: it says when, and ' +
    'waits for it; --rush starts it now at the rush rate, and --no-wait returns at once.'

  static flags = {
    ...BaseCommand.baseFlags,
    timeout: Flags.integer({description: 'Compile timeout in seconds, counted from the compile\'s start', default: 600}),
    rush: Flags.boolean({
      description: RUSH_FLAG_DESCRIPTION,
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after triggering compilation. Prints the thread ID for manual polling.',
      default: false,
    }),
  }

  static args = {
    thread_id: Args.string({description: 'Thread ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadMake)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    let makeResponse: Record<string, unknown>
    try {
      makeResponse = await client.post(`/v1/compile/threads/${seg(args.thread_id)}/make`, flags.rush ? {body: {rush: true}} : {}) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        // A refusal names why in `error_code`; the fix is ours to add. Nothing
        // was compiled and nothing was charged.
        this.error(makeRefusalMessage(err, args.thread_id))
      }
      throw err
    }

    // Queued means it waits behind the face's other sources (one face compiles
    // one source at a time), which is worth saying before a long quiet wait.
    const queued = compileStatusOf(makeResponse.status) === 'queued'
    // When it starts, if not at once, and what became of --rush.
    const schedule = makeScheduleLines(makeResponse, flags.rush)
    const scheduled = makeResponse.rush !== true && msUntilStart(makeResponse.starts_at) > 0
    if (!json) for (const line of schedule) process.stderr.write(`${line}\n`)

    if (flags['no-wait']) {
      if (!json) {
        process.stderr.write(`Compilation started in background${queued ? ' (queued)' : ''}.\n`)
        process.stderr.write(`Poll with: faces compile:thread:get ${args.thread_id} --json\n`)
      }
      return makeResponse
    }

    if (!json) {
      process.stderr.write(scheduled
        ? 'Waiting for the scheduled start; it starts on its own, so stopping here leaves it scheduled.\n' +
          `To start it now instead: faces compile:thread:make ${args.thread_id} --rush\n`
        : `Compiling${queued ? ' (queued, and it starts on its own)' : ''}:\n`)
    }

    let result: unknown
    try {
      result = await pollCompileProgress(client, args.thread_id, {
        timeoutMs: flags.timeout * 1000,
        startsAt: makeResponse.starts_at as string | null | undefined,
        endpoint: `/v1/compile/threads/${seg(args.thread_id)}`,
        onProgress: (p: PollProgress) => {
          if (!json) process.stderr.write(`  ${progressLine(p)}\n`)
        },
      })
    } catch (err) {
      if (err instanceof Error) this.error(err.message)
      throw err
    }

    if (!json) process.stderr.write('Done.\n')
    // The start and rush /make answered, when the final read does not carry them.
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>
      if (r.starts_at === undefined && 'starts_at' in makeResponse) r.starts_at = makeResponse.starts_at
      if (r.rush === undefined && 'rush' in makeResponse) r.rush = makeResponse.rush
    }
    if (json) this.log(JSON.stringify(result, null, 2))
    return result
  }
}
