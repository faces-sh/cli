import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {freshnessLines, messagesAfterSync, seg} from '../../../utils.js'

export default class CompileThreadGet extends BaseCommand {
  static description =
    'Get a thread by ID. Says so when messages have arrived since the last compile, or when a compile ' +
    'would be refused.'

  static flags = {
    ...BaseCommand.baseFlags,
    'status-only': Flags.boolean({
      description:
        'Fetch just the compile state, leaving out the messages. Hundreds of times smaller, and the right ' +
        'thing to poll with.',
      default: false,
    }),
  }

  static args = {
    thread_id: Args.string({description: 'Thread ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadGet)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      const query = flags['status-only'] ? '?status_only=true' : ''
      data = await client.get(`/v1/compile/threads/${seg(args.thread_id)}${query}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      this.printHuman(data)

      const t = data as {
        messages?: Array<{timestamp?: string | null}> | null
        synced_at?: string | null
      }
      const lines = freshnessLines(
        data as Record<string, never>,
        `faces compile:thread:make ${args.thread_id}`,
        args.thread_id,
      )

      // A thread's revision counter is not the whole story: messages carry their
      // own timestamps, so say how many arrived after the compile read the room.
      const {newer} = messagesAfterSync(t.messages, t.synced_at)
      if (newer > 0) {
        lines.unshift(`Stale: ${newer} message(s) arrived after the last compile.`)
      }

      if (lines.length > 0) {
        this.log('')
        for (const line of lines) this.log(line)
      }
    }

    return data
  }
}
