import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {loadConfig, saveConfig} from '../../config.js'
import {seg} from '../../utils.js'

export default class KeysRevoke extends BaseCommand {
  static description = 'Revoke an API key (JWT required)'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    key_id: Args.string({description: 'Key ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(KeysRevoke)
    const client = this.makeClient(flags)

    await this.confirmOrRefuse(`Revoke key '${args.key_id}'?`, flags.yes)

    // A revoked key left in the config broke every later command with a 401.
    // Find out first whether this is that key, by its prefix.
    const saved = loadConfig().api_key
    let prefix: string | undefined
    if (saved) {
      try {
        const listed = (await client.get('/v1/auth/api-keys', {requireJwt: true})) as unknown
        const keys = (Array.isArray(listed) ? listed : ((listed as {data?: unknown[]})?.data ?? [])) as Array<Record<string, unknown>>
        prefix = keys.find((k) => k.id === args.key_id)?.key_prefix as string | undefined
      } catch {
        // without the list the saved key is left as it is
      }
    }

    let data: unknown
    try {
      data = await client.delete(`/v1/auth/api-keys/${seg(args.key_id)}`, {requireJwt: true})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const clearedSaved = Boolean(saved && prefix && saved.startsWith(prefix))
    if (clearedSaved) saveConfig({api_key: undefined})
    if (!this.jsonEnabled()) {
      this.printHuman(data)
      if (clearedSaved) this.log('This was the API key saved in your config, so it was removed from there too.')
    }

    return clearedSaved ? {...(data as Record<string, unknown>), _removed_from_config: true} : data
  }

}
