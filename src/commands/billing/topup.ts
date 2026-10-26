import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {parseBudget} from '../../utils.js'

export default class BillingTopup extends BaseCommand {
  static description = 'Top up your credit balance. Charges your default card, or the one --card names.'

  static flags = {
    ...BaseCommand.baseFlags,
    amount: Flags.string({description: 'Top-up amount in USD (min $1)', required: true}),
    card: Flags.string({description: 'Charge this saved card (pm_..., from faces billing:cards) instead of the default'}),
    yes: Flags.boolean({description: 'Charge without asking first', default: false}),
    'allow-duplicate': Flags.boolean({
      description:
        'Charge even if this repeats a recent top-up. Without it a repeat is refused, so a retried command ' +
        'cannot charge twice. --yes does not imply it.',
      default: false,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingTopup)
    const client = this.makeClient(flags)

    // Strict: parseFloat read "1abc" as 1 and "1e6" as a million, and a card
    // cannot be charged a fraction of a cent.
    const amount = parseBudget(flags.amount, (m) => this.error(m), '--amount', 10_000)
    if (amount < 1) this.error('Minimum topup is $1.00 (--amount)')
    await this.confirmOrRefuse(`Charge $${amount.toFixed(2)} to ${flags.card ?? 'your default card'}?`, flags.yes)

    const payload: Record<string, unknown> = {amount_usd: amount}
    if (flags.card) payload.payment_method_id = flags.card
    if (flags['allow-duplicate']) payload.allow_duplicate = true

    let data: unknown
    try {
      data = await client.post('/v1/billing/topup', {requireJwt: true, body: payload})
    } catch (err) {
      // A repeat of a recent top-up is held back, nothing charged. Charging it
      // again is the person's call, asked for here or with --allow-duplicate.
      if (!(err instanceof FacesAPIError && err.statusCode === 409 && err.errorCode === 'duplicate_topup')) this.fail(err, flags.card)
      if (this.jsonEnabled() || !process.stdin.isTTY) {
        this.error(`${err.message}\nNothing was charged. To charge it again anyway, re-run with --allow-duplicate.`)
      }
      await this.confirmOrRefuse(`${err.message}\nCharge $${amount.toFixed(2)} again anyway?`, false)
      try {
        data = await client.post('/v1/billing/topup', {requireJwt: true, body: {...payload, allow_duplicate: true}})
      } catch (again) {
        this.fail(again, flags.card)
      }
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }

  private fail(err: unknown, card?: string): never {
    if (err instanceof FacesAPIError) {
      if (err.statusCode === 404 && card) this.error(`HTTP 404: ${err.message}\nList your cards with: faces billing:cards`)
      this.error(`HTTP ${err.statusCode}: ${err.message}`)
    }
    throw err
  }
}
