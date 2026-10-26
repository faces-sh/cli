import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'

export default class BillingCardSetup extends BaseCommand {
  static description =
    'Add a card: prints a secure link to save one. Nothing is charged. The new card becomes the default ' +
    'unless --no-default (the first card always does), and it is listed a few seconds after you finish.'

  static aliases = ['billing:card:add']

  static flags = {
    ...BaseCommand.baseFlags,
    default: Flags.boolean({
      description: 'Make the new card the default, which renewals and top-ups charge',
      default: true,
      allowNo: true,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingCardSetup)
    const client = this.makeClient(flags)

    let data: Record<string, unknown>
    try {
      data = await client.post('/v1/billing/card-setup', flags.default ? {} : {body: {make_default: false}}) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      if (typeof data.checkout_url === 'string') {
        this.log('Save a card at this link (nothing is charged):')
        this.log(`  ${data.checkout_url}`)
        this.log('')
        // It reaches the account through Stripe's webhook, not this call.
        this.log('It appears a few seconds after you finish. Check with: faces billing:cards')
      } else {
        this.printHuman(data)
      }
    }
    return data
  }
}
