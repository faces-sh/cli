import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {freshnessLines, seg} from '../../../utils.js'

export default class CompileDocGet extends BaseCommand {
  static description =
    'Get a document by ID. Says so when the text has moved on since the last compile, or when a compile ' +
    'would be refused.'

  static flags = {
    ...BaseCommand.baseFlags,
    'status-only': Flags.boolean({
      description:
        'Fetch just the compile state, leaving out the document text. Hundreds of times smaller, and the ' +
        'right thing to poll with.',
      default: false,
    }),
  }

  static args = {
    doc_id: Args.string({description: 'Document ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDocGet)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      const query = flags['status-only'] ? '?status_only=true' : ''
      data = await client.get(`/v1/compile/documents/${seg(args.doc_id)}${query}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      this.printHuman(data)
      const lines = freshnessLines(
        data as Record<string, never>,
        `faces compile:doc:make ${args.doc_id}`,
        args.doc_id,
      )
      if (lines.length > 0) {
        this.log('')
        for (const line of lines) this.log(line)
      }
    }

    return data
  }
}
