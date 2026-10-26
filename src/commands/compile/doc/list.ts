import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {freshnessSummary} from '../../../utils.js'

export default class CompileDocList extends BaseCommand {
  static description =
    "List documents for a face. Each document's full text is omitted unless --verbose, so a face with a " +
    'real corpus stays readable. For a table of every source, documents and threads together, use face:sources.'

  static flags = {
    ...BaseCommand.baseFlags,
    verbose: Flags.boolean({description: "Include each document's full text", default: false}),
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDocList)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/compile/documents', {params: {alias: args.face_id}})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // --json is untouched: machine callers may already read `content`, and
    // dropping a field from structured output would break them silently.
    if (!this.jsonEnabled()) {
      const items = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
      const omitted = flags.verbose ? 0 : items.filter((d) => typeof d.content === 'string' && d.content !== '').length

      this.printHuman(
        flags.verbose
          ? data
          : items.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'content'))),
      )

      // Say that something was left out. A list that quietly drops a field
      // reads as complete, which is how this became a problem in the first place.
      if (omitted > 0) {
        this.log('')
        this.log(`Text omitted for ${omitted} document(s). Pass --verbose to include it.`)
      }

      // A list that reads "synced" for a document rewritten since is the thing
      // the revision fields exist to end.
      const summary = freshnessSummary(items as Array<Record<string, never>>, 'document')
      if (summary.length > 0) {
        this.log('')
        for (const line of summary) this.log(line)
      }
    }

    return data
  }
}
