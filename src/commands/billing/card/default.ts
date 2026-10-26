import {Args} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class BillingCardDefault extends BaseCommand {
  static description = 'Make a saved card the default: the next renewal, and any top-up that names no card, charges it'

  static examples = ['<%= config.bin %> <%= command.id %> pm_EXAMPLE']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    card_id: Args.string({description: 'Card id (pm_...), from faces billing:cards', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(BillingCardDefault)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.post(`/v1/billing/payment-methods/${seg(args.card_id)}/default`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`HTTP 404: ${err.message}\nList your cards with: faces billing:cards`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) this.log(`${args.card_id} is now the default card.`)
    return data
  }
}
