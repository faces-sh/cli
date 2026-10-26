import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class GroupTagAdd extends BaseCommand {

  static description = 'Add tags to a group (appends, idempotent)'

  static flags = {
    ...BaseCommand.baseFlags,
    tag: Flags.string({description: 'Tag to add (repeatable)', multiple: true, required: true}),
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupTagAdd)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.post(`/v1/groups/${seg(args.group_id)}/tags`, {body: {tags: flags.tag}})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
