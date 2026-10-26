import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {GroupCatalogService, stripFrontmatter} from '../../group-catalog.js'
import {seg} from '../../utils.js'

export default class GroupEdit extends BaseCommand {

  static description = 'Edit a group'

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'New group name'}),
    description: Flags.string({description: 'New description (max 1500 chars)'}),
    protocol: Flags.string({description: 'New protocol content'}),
    'protocol-file': Flags.string({description: 'Read protocol from file'}),
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupEdit)
    const client = this.makeClient(flags)

    let protocol = flags.protocol
    if (flags['protocol-file']) {
      if (!fs.existsSync(flags['protocol-file'])) this.error(`File not found: ${flags['protocol-file']}`)
      // A TEAM.md carries metadata above the protocol; only the protocol is sent.
      protocol = stripFrontmatter(fs.readFileSync(flags['protocol-file'], 'utf8'))
    }

    const payload: Record<string, unknown> = {}
    if (flags.name) payload.name = flags.name
    if (flags.description !== undefined) payload.description = flags.description
    if (protocol !== undefined) payload.protocol = protocol

    if (Object.keys(payload).length === 0) this.error('Provide at least one field to update.')

    let data: unknown
    try {
      data = await client.patch(`/v1/groups/${seg(args.group_id)}`, {body: payload})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // Update local TEAM.md
    try {
      const group = data as Record<string, unknown>
      const groupCatalog = new GroupCatalogService()
      const slug = String(group.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

      // Fetch members for the local file
      let members: string[] = []
      try {
        const membersResp = await client.get(`/v1/groups/${seg(args.group_id)}/members`) as {data?: Array<Record<string, unknown>>}
        // The aliases, which is what /facechat reads; the iam_id only when none.
        members = (membersResp.data ?? []).map(m => (m.alias ?? m.iam_id) as string)
      } catch { /* proceed without members */ }

      // Fetch tags
      let tags: string[] = []
      try {
        const tagResp = await client.get(`/v1/groups/${seg(args.group_id)}/tags`) as {tags?: string[]}
        tags = tagResp.tags ?? []
      } catch { /* proceed */ }

      groupCatalog.writeGroup(slug, {
        id: args.group_id,
        name: group.name as string,
        description: (group.description as string) ?? undefined,
        tags,
        members,
      }, (group.protocol as string) ?? undefined)
    } catch { /* non-fatal */ }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
