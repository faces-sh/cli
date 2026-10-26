import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class BillingCardRemove extends BaseCommand {
  static description =
    'Remove a saved card. Removing the default makes the newest other card the default. The last card ' +
    'cannot be removed while a paid subscription renews on it.'

  static examples = ['<%= config.bin %> <%= command.id %> pm_EXAMPLE --yes']

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    card_id: Args.string({description: 'Card id (pm_...), from faces billing:cards', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(BillingCardRemove)
    const client = this.makeClient(flags)

    await this.confirmOrRefuse(`Remove card ${args.card_id}?`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`/v1/billing/payment-methods/${seg(args.card_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`HTTP 404: ${err.message}\nList your cards with: faces billing:cards`)
        if (err.statusCode === 409) {
          this.error(
            `HTTP 409: ${err.message}\n` +
              'Add another card first (faces billing:card-setup), or cancel the subscription ' +
              '(faces billing:subscription:cancel).',
          )
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) this.log(`Removed ${args.card_id}. See what is left with: faces billing:cards`)
    return data
  }
}
