import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg, parseBudget} from '../../utils.js'

export default class KeysUpdate extends BaseCommand {
  static description = 'Update API key metadata (JWT required)'

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'New key name'}),
    budget: Flags.string({description: 'New lifetime spend cap in USD, e.g. 5 or 0.50'}),
    'reset-spent': Flags.boolean({description: 'Reset spent amount to zero', default: false}),
  }

  static args = {
    key_id: Args.string({description: 'Key ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(KeysUpdate)
    const client = this.makeClient(flags)

    const payload: Record<string, unknown> = {}
    if (flags.name) payload.name = flags.name
    if (flags.budget !== undefined) payload.budget_usd = parseBudget(flags.budget, (m) => this.error(m))
    if (flags['reset-spent']) payload.reset_spent = true

    if (Object.keys(payload).length === 0) this.error('Provide at least one field to update.')

    let data: unknown
    try {
      data = await client.patch(`/v1/auth/api-keys/${seg(args.key_id)}`, {requireJwt: true, body: payload})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
