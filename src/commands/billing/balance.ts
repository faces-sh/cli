import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {usd} from '../../utils.js'

export default class BillingBalance extends BaseCommand {
  static description = 'Show credit balance and payment method status'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingBalance)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/billing/balance')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      // Dollars, with the sign: a bare 9.518832 read as a count.
      const d = data as Record<string, unknown>
      this.printHuman({...d, balance_usd: typeof d.balance_usd === 'number' ? usd(d.balance_usd) : d.balance_usd})
    }
    return data
  }
}
