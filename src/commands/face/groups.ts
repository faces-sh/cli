import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class FaceGroups extends BaseCommand {

  static description = "Set a face's group memberships (replaces all)"

  static flags = {
    ...BaseCommand.baseFlags,
    group: Flags.string({
      description: 'Group ID (repeatable, replaces all memberships)',
      multiple: true,
      required: true,
    }),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceGroups)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.put(`/v1/faces/${seg(args.alias)}/groups`, {body: {group_ids: flags.group}})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
