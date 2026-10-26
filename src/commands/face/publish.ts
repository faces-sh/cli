import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class FacePublish extends BaseCommand {
  static description =
    'Publish a face so EVERY account can chat with it. This is a global override: while it is on, ' +
    'everyone can reach the face regardless of who it is shared with. You still pay only to compile it; ' +
    'whoever chats pays for their own inference.'

  static examples = ['<%= config.bin %> <%= command.id %> alice --yes']

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FacePublish)
    const client = this.makeClient(flags)

    if (!flags.yes) {
      this.error(
        `This makes '${args.alias}' chattable by every account on the platform. Re-run with --yes to confirm.`,
      )
    }

    let data: Record<string, unknown>
    try {
      data = (await client.patch(`/v1/faces/${seg(args.alias)}/publish`, {
        requireJwt: true,
        body: {published: true},
      })) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (this.jsonEnabled()) return data
    this.log(`'${args.alias}' is published.`)
    if (data.handle) this.log(`Anyone can chat it as: ${data.handle}@<model>`)
    this.log(`Unpublish with: faces face:unpublish ${args.alias}`)
    return data
  }
}
