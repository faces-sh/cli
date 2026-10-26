import {Args} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class GroupTagList extends BaseCommand {

  static description = 'List tags on a group'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupTagList)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get(`/v1/groups/${seg(args.group_id)}/tags`)
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
