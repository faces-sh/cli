import {Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {PAID_PLANS, PLAN_PRICE, PaidPlan, planName} from '../../../billing.js'

export default class BillingSubscriptionActivate extends BaseCommand {
  static description =
    'Subscribe to Connect ($17/month) or Pro ($49/month) from the Free plan, or reactivate a subscription ' +
    'that is set to cancel. Already subscribed? Change plan with billing:subscription:plan instead.'

  static aliases = ['billing:subscribe']

  static examples = [
    '<%= config.bin %> <%= command.id %> --plan connect',
    '<%= config.bin %> <%= command.id %> --plan pro',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    plan: Flags.string({
      description: 'Plan to subscribe to. Default: the current plan when it is set to cancel (which reactivates it), otherwise connect.',
      options: [...PAID_PLANS],
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingSubscriptionActivate)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    let sub: Record<string, unknown>
    try {
      sub = await client.get('/v1/billing/subscription') as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const plan = String(sub.plan ?? 'free')
    const cancelAtPeriodEnd = sub.cancel_at_period_end === true
    // With no --plan, a paid plan set to cancel means "keep it". Defaulting to
    // Connect answered a Pro user's reactivation with a downgrade.
    const want = (flags.plan ?? ((PAID_PLANS as readonly string[]).includes(plan) && cancelAtPeriodEnd ? plan : 'connect')) as PaidPlan

    if (plan === want && !cancelAtPeriodEnd) {
      if (!json) this.log(`Already on the ${planName(want)} plan.`)
      return {status: 'already_active', plan: want}
    }

    // Set to cancel: reactivate it rather than opening a second checkout.
    if (plan === want && cancelAtPeriodEnd) {
      let data: unknown
      try {
        data = await client.post('/v1/billing/subscription/reactivate', {requireJwt: true})
      } catch (err) {
        if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
        throw err
      }

      const result = data as Record<string, unknown>
      if (!json) {
        this.log(`Reactivated. The ${planName(want)} plan continues. Next renewal: ${result.current_period_end ?? 'unknown'}.`)
      }

      return {status: 'reactivated', ...result}
    }

    // On another paid plan a second checkout would bill twice; the server
    // refuses it (409). Switching is its own command.
    if (plan !== 'free') {
      if (plan === 'team') this.error('Your plan is managed by Faces, so there is nothing to subscribe to.')
      if (cancelAtPeriodEnd) {
        this.error(
          `Your ${planName(plan)} plan is set to cancel. Keep it first with: faces billing:subscription:activate\n` +
            `Then, to change to ${planName(want)}: faces billing:subscription:plan ${want}`,
        )
      }

      this.error(
        `You already subscribe to ${planName(plan)}. To change to ${planName(want)}, with proration:\n` +
          `  faces billing:subscription:plan ${want}`,
      )
    }

    let data: unknown
    try {
      data = await client.post(`/v1/billing/checkout?plan=${want}&source=cli`, {requireJwt: true})
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 409) this.error(`HTTP 409: ${err.message}\nChange plan with: faces billing:subscription:plan ${want}`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    const result = data as Record<string, unknown>
    const url = result.checkout_url as string

    if (!json) {
      this.log(`${planName(want)}: ${PLAN_PRICE[want]}`)
      this.log('')
      this.log('Complete payment at this link (it takes a promo code too):')
      this.log(`  ${url}`)
      this.log('')
      this.log('After payment, check with: faces billing:subscription')
    }

    return {status: 'checkout_created', plan: want, checkout_url: url}
  }
}
