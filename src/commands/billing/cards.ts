import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {Card, cardLine} from '../../billing.js'

export default class BillingCards extends BaseCommand {
  static description =
    'List your saved cards, newest first. The default card is the one the subscription renews on and a ' +
    'top-up charges unless it names another (--card).'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingCards)
    const client = this.makeClient(flags)

    let data: {default_payment_method?: string | null; payment_methods?: Card[]}
    try {
      data = await client.get('/v1/billing/payment-methods') as typeof data
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const cards = data.payment_methods ?? []
      if (cards.length === 0) {
        this.log('No saved cards. Add one with: faces billing:card-setup')
      } else {
        for (const c of cards) this.log(cardLine(c))
      }
    }
    return data
  }
}
