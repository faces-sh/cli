import {Args} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {freshnessSummary} from '../../../utils.js'

export default class CompileThreadList extends BaseCommand {
  static description =
    'List threads for a face, saying how many have moved on since their last compile and how many a ' +
    'compile would be refused for.'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadList)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/compile/threads', {params: {alias: args.face_id}})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      this.printHuman(data)
      const items = Array.isArray(data) ? (data as Array<Record<string, never>>) : []
      const summary = freshnessSummary(items, 'thread')
      if (summary.length > 0) {
        this.log('')
        for (const line of summary) this.log(line)
      }
    }

    return data
  }
}
