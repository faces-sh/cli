import {Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {GroupCatalogService, stripFrontmatter} from '../../group-catalog.js'
import {seg} from '../../utils.js'

export default class GroupCreate extends BaseCommand {

  static description = 'Create a new group'

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Group name', required: true}),
    description: Flags.string({description: 'Plain-text group description (max 1500 chars)'}),
    protocol: Flags.string({description: 'Protocol content (mermaid diagram or markdown, max 1000 words)'}),
    'protocol-file': Flags.string({description: 'Read protocol from file'}),
    tag: Flags.string({description: 'Tag label (repeatable, lowercase)', multiple: true}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(GroupCreate)
    const client = this.makeClient(flags)

    let protocol = flags.protocol
    if (flags['protocol-file']) {
      if (!fs.existsSync(flags['protocol-file'])) this.error(`File not found: ${flags['protocol-file']}`)
      // A TEAM.md carries metadata above the protocol; only the protocol is sent.
      protocol = stripFrontmatter(fs.readFileSync(flags['protocol-file'], 'utf8'))
    }

    const payload: Record<string, unknown> = {name: flags.name}
    if (flags.description) payload.description = flags.description
    if (protocol) payload.protocol = protocol

    let data: unknown
    try {
      data = await client.post('/v1/groups', {body: payload})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const group = data as Record<string, unknown>

    // Post tags if provided
    const tags = flags.tag ?? []
    if (tags.length > 0) {
      try {
        await client.post(`/v1/groups/${seg(String(group.id))}/tags`, {body: {tags}})
        group.tags = tags
      } catch (err) {
        if (err instanceof FacesAPIError) this.warn(`Tags failed (${err.statusCode}): ${err.message}`)
      }
    }

    // Write local TEAM.md
    try {
      const groupCatalog = new GroupCatalogService()
      const slug = String(group.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      groupCatalog.writeGroup(slug, {
        id: group.id as string,
        name: group.name as string,
        description: (group.description as string) ?? undefined,
        tags: (group.tags as string[]) ?? undefined,
        members: [],
      }, (group.protocol as string) ?? protocol ?? undefined)
    } catch { /* non-fatal */ }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
