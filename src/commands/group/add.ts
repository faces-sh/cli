import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {GroupCatalogService} from '../../group-catalog.js'
import {resolveFace, seg} from '../../utils.js'

export default class GroupAdd extends BaseCommand {

  static description =
    'Add face(s) to a group. Any face this account can reach may join: your own, a published one, or one ' +
    'shared with you. Name someone else\'s as owner:alias, the same address chat uses.'

  static flags = {
    ...BaseCommand.baseFlags,
    face: Flags.string({description: 'Face alias to add (repeatable)', multiple: true, required: true}),
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %> GROUP_ID --face alice --face bob',
    '<%= config.bin %> <%= command.id %> GROUP_ID --face head:socrates',
  ]

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupAdd)
    const client = this.makeClient(flags)

    // Resolve to iam_ids. The members endpoint takes a uid or an owner:alias
    // and not a bare alias, so resolving here means a user can name any face
    // the way they already name it everywhere else. resolveFace also finds
    // published and shared faces, which the plain face route cannot.
    const iamIds: string[] = []
    for (const alias of flags.face) {
      // A qualified owner:alias goes straight through. The members endpoint
      // resolves it server-side, and asking the listing first would substitute
      // our view for the server's: a published face can be reachable before it
      // appears in the listing, so resolving here would refuse a face that
      // would have been accepted.
      if (alias.includes(':')) {
        iamIds.push(alias)
        continue
      }

      let resolved
      try {
        resolved = await resolveFace(client, alias)
      } catch (err) {
        if (err instanceof FacesAPIError) {
          if (err.statusCode === 404) {
            this.error(
              `No face '${alias}'. If it belongs to another account, name it as owner:alias. ` +
                'Find it with: faces face:list --public',
            )
          }
          this.error(`Could not resolve '${alias}' (HTTP ${err.statusCode}): ${err.message}`)
        }
        throw err
      }

      const face = resolved.face
      const id = (face.uid ?? face.id ?? face.iam_id) as string
      if (!id) this.error(`Could not find the owner of face '${alias}'.`)
      iamIds.push(id)
    }

    let data: unknown
    try {
      if (iamIds.length === 1) {
        data = await client.post(`/v1/groups/${seg(args.group_id)}/members`, {body: {iam_id: iamIds[0]}})
      } else {
        data = await client.post(`/v1/groups/${seg(args.group_id)}/members`, {body: {iam_ids: iamIds}})
      }
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // Update local TEAM.md: find by group ID and add aliases
    try {
      const groupCatalog = new GroupCatalogService()
      for (const name of groupCatalog.listGroups()) {
        const group = groupCatalog.readGroup(name)
        if (group?.frontmatter.id === args.group_id) {
          const members = new Set(group.frontmatter.members ?? [])
          for (const alias of flags.face) members.add(alias)
          group.frontmatter.members = [...members]
          groupCatalog.writeGroup(name, group.frontmatter, group.body || undefined)
          break
        }
      }
    } catch { /* non-fatal */ }

    if (!this.jsonEnabled()) {
      this.log(`Added ${flags.face.join(', ')} to group.`)
    }

    return data
  }
}
