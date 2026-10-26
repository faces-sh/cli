import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class FaceLock extends BaseCommand {
  static description =
    'Lock a face (read-only). A locked face still reads and chats normally, but it, and everything it owns (documents, threads, built styles), cannot be changed until unlocked.'

  static examples = ['<%= config.bin %> <%= command.id %> socrates']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceLock)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.patch(`/v1/faces/${seg(args.face_id)}/lock`, {body: {read_only: true}})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const res = data as {alias?: string; affected?: string[]}
      this.log(`Locked '${res.alias ?? args.face_id}' is now read only.`)
      const affected = res.affected ?? []
      if (affected.length > 0) this.log(`Affected: ${affected.join(', ')}`)
    }

    return data
  }
}
