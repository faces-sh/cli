import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {CatalogService} from '../../../catalog.js'
import {seg} from '../../../utils.js'

export default class FaceTagSet extends BaseCommand {
  static description = 'Replace all tags on a face'

  static flags = {
    ...BaseCommand.baseFlags,
    tag: Flags.string({description: 'Tag to set (repeatable, replaces all)', multiple: true, required: true}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceTagSet)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.put(`/v1/iam/${seg(args.alias)}/tags`, {body: {tags: flags.tag}})
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 403) {
          this.error(`Forbidden: face '${args.alias}' is not owned by the current account. Run \`faces catalog:doctor --fix\` to sync.`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    // Sync tags to local catalog
    const tags = (data as {tags?: string[]}).tags ?? []
    try { new CatalogService().updateTags(args.alias, tags) } catch { /* non-fatal */ }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
