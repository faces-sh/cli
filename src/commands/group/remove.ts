import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {GroupCatalogService} from '../../group-catalog.js'
import {seg} from '../../utils.js'

export default class GroupRemove extends BaseCommand {

  static description = 'Remove a face from a group'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
    alias: Args.string({description: 'Face alias to remove', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupRemove)
    const client = this.makeClient(flags)

    // Resolve alias to iam_id
    let iamId: string
    try {
      const face = await client.get(`/v1/faces/${seg(args.alias)}`) as Record<string, unknown>
      iamId = (face.uid ?? face.id ?? face.iam_id) as string
      if (!iamId) this.error(`Could not find the owner of face '${args.alias}'.`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`Could not resolve '${args.alias}' (HTTP ${err.statusCode}): ${err.message}`)
      throw err
    }

    let data: unknown
    try {
      data = await client.delete(`/v1/groups/${seg(args.group_id)}/members/${seg(iamId)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // Update local TEAM.md: find by group ID and remove alias
    try {
      const groupCatalog = new GroupCatalogService()
      for (const name of groupCatalog.listGroups()) {
        const group = groupCatalog.readGroup(name)
        if (group?.frontmatter.id === args.group_id) {
          group.frontmatter.members = (group.frontmatter.members ?? []).filter(m => m !== args.alias)
          groupCatalog.writeGroup(name, group.frontmatter, group.body || undefined)
          break
        }
      }
    } catch { /* non-fatal */ }

    if (!this.jsonEnabled()) this.log(`Removed ${args.alias} from group.`)
    return data
  }
}
