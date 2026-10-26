import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {CatalogService} from '../../../catalog.js'
import {seg} from '../../../utils.js'

export default class FaceTagRemove extends BaseCommand {
  static description = 'Remove a tag from a face'

  static flags = {
    ...BaseCommand.baseFlags,
    // face:tag:add and face:tag:set take --tag; this took only a positional,
    // so the same habit failed here.
    tag: Flags.string({description: 'Tag to remove (or give it as the second argument)'}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
    tag: Args.string({description: 'Tag to remove'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceTagRemove)
    const client = this.makeClient(flags)
    const tag = args.tag ?? flags.tag
    if (!tag) this.error('Name the tag to remove: faces face:tag:remove <alias> <tag>, or --tag <tag>')

    let data: unknown
    try {
      data = await client.delete(`/v1/iam/${seg(args.alias)}/tags/${seg(tag)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 403) {
          this.error(`Forbidden: face '${args.alias}' is not owned by the current account. Run \`faces catalog:doctor --fix\` to sync.`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    // Refresh tags in local catalog
    try {
      const tagResp = await client.get(`/v1/iam/${seg(args.alias)}/tags`) as {tags?: string[]}
      new CatalogService().updateTags(args.alias, tagResp.tags ?? [])
    } catch { /* non-fatal */ }

    if (!this.jsonEnabled()) this.log(`Removed tag '${tag}' from ${args.alias}`)
    return data
  }
}
