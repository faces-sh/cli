import {Args} from '@oclif/core'

import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class AuthDisconnect extends BaseCommand {
  static description = 'Disconnect a linked OAuth provider account'

  static args = {
    provider: Args.string({
      description: 'OAuth provider to disconnect',
      required: true,
      options: ['openai'],
    }),
  }

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static examples = [
    '<%= config.bin %> auth:disconnect openai',
  ]

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(AuthDisconnect)
    const client = this.makeClient(flags, true)

    // The route answers 200 with nothing linked, which printed "disconnected".
    try {
      const rows = (await client.get('/v1/oauth', {requireJwt: true})) as Array<Record<string, unknown>>
      if (Array.isArray(rows) && !rows.some((r) => r.provider === args.provider)) {
        this.error(`No ${args.provider} account is connected, so there is nothing to disconnect. See: faces auth:connections`)
      }
    } catch (err) {
      if (!(err instanceof FacesAPIError)) throw err
    }

    try {
      await client.delete(`/v1/oauth/${seg(args.provider)}`, {requireJwt: true})
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404)
          this.error(`No connected ${args.provider} account found.`)
        this.error(`Disconnect failed (${err.statusCode}): ${err.message}`)
      }
      throw err
    }

    const output = {provider: args.provider, connected: false}
    if (!this.jsonEnabled())
      this.log(`✅ ${args.provider} disconnected.`)
    return output
  }
}
