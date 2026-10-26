import {Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {planName} from '../../../billing.js'

export default class BillingSubscriptionCancel extends BaseCommand {
  static description = 'Cancel your subscription (keeps access until period end)'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingSubscriptionCancel)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    // Fetch current state
    let sub: Record<string, unknown>
    try {
      sub = await client.get('/v1/billing/subscription') as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const plan = sub.plan as string

    if (plan === 'free') {
      if (!json) this.log('No subscription to cancel: you are on the Free plan, which pays as it goes.')
      return {status: 'no_subscription'}
    }
    const name = planName(plan)

    if (sub.cancel_at_period_end) {
      if (!json) this.log(`Already canceled. ${name} access ends ${sub.current_period_end ?? 'at period end'}.`)
      return {status: 'already_canceled', current_period_end: sub.current_period_end}
    }

    // Confirm
    const periodEnd = sub.current_period_end ?? 'period end'
    await this.confirmOrRefuse(`Cancel the ${name} plan? You'll keep access until ${periodEnd}.`, flags.yes)

    let data: unknown
    try {
      data = await client.post('/v1/billing/subscription/cancel')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const result = data as Record<string, unknown>
    if (!json) {
      this.log(`Canceled. ${name} access continues until ${result.current_period_end ?? 'period end'}.`)
      this.log(`To reactivate before then: faces billing:subscription:activate --plan ${plan}`)
    }

    return {status: 'canceled', ...result}
  }

}
