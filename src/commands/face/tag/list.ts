import {Args} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class FaceTagList extends BaseCommand {
  static description = 'List tags on a face'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceTagList)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get(`/v1/iam/${seg(args.alias)}/tags`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const tags = (data as {tags: string[]}).tags ?? []
      if (tags.length === 0) {
        this.log('(no tags)')
      } else {
        this.log(tags.join(', '))
      }
    }

    return data
  }
}
