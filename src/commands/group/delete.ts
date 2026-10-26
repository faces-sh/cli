import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {GroupCatalogService} from '../../group-catalog.js'
import {seg} from '../../utils.js'

export default class GroupDelete extends BaseCommand {

  static description = 'Delete a group'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupDelete)
    const client = this.makeClient(flags)

    await this.confirmOrRefuse(`Delete group '${args.group_id}'?`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`/v1/groups/${seg(args.group_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // A TEAM.md left behind kept the deleted group resolvable from /facechat.
    const groupCatalog = new GroupCatalogService()
    const local = groupCatalog.findById(args.group_id)
    if (local) groupCatalog.deleteGroup(local)

    if (!this.jsonEnabled()) {
      this.printHuman(data)
      if (local) this.log(`Removed the local copy: ~/.faces/teams/${local}`)
    }

    return data
  }

}
