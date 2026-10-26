import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class GroupGet extends BaseCommand {

  static description = 'Get a group by ID'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupGet)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get(`/v1/groups/${seg(args.group_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
