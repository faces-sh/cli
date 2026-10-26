import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class FaceUnpublish extends BaseCommand {
  static description =
    'Stop publishing a face. Anyone it is individually shared with keeps their access. Publishing is an ' +
    'override on top of sharing, not a replacement for it.'

  static flags = {...BaseCommand.baseFlags}

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceUnpublish)
    const client = this.makeClient(flags)

    let data: Record<string, unknown>
    try {
      data = (await client.patch(`/v1/faces/${seg(args.alias)}/publish`, {
        requireJwt: true,
        body: {published: false},
      })) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (this.jsonEnabled()) return data
    this.log(`'${args.alias}' is no longer published.`)
    return data
  }
}
