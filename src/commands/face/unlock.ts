import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class FaceUnlock extends BaseCommand {
  static description =
    'Unlock a face (make it writable again). Thaws the face and everything it owns (documents, threads, built styles).'

  static examples = ['<%= config.bin %> <%= command.id %> socrates']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceUnlock)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.patch(`/v1/faces/${seg(args.face_id)}/lock`, {body: {read_only: false}})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const res = data as {alias?: string; affected?: string[]}
      this.log(`Unlocked '${res.alias ?? args.face_id}' is now writable.`)
      const affected = res.affected ?? []
      if (affected.length > 0) this.log(`Affected: ${affected.join(', ')}`)
    }

    return data
  }
}
