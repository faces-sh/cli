import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {PAID_PLANS, PLAN_PRICE, PaidPlan, planName} from '../../../billing.js'

export default class BillingSubscriptionPlan extends BaseCommand {
  static description =
    'Switch a subscription between Connect ($17/month) and Pro ($49/month) in place. The difference is ' +
    'prorated on the default card, and the new allowances apply at once. From the Free plan, subscribe ' +
    'with billing:subscription:activate instead.'

  static examples = [
    '<%= config.bin %> <%= command.id %> pro',
    '<%= config.bin %> <%= command.id %> connect --yes',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    plan: Args.string({description: 'Plan to switch to', options: [...PAID_PLANS], required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(BillingSubscriptionPlan)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    const want = args.plan as PaidPlan

    let sub: Record<string, unknown>
    try {
      sub = await client.get('/v1/billing/subscription') as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }
    const plan = String(sub.plan ?? 'free')

    if (plan === want) {
      if (!json) this.log(`Already on the ${planName(want)} plan.`)
      return {status: 'already_active', plan: want}
    }
    if (plan === 'free') {
      this.error(`You have no subscription to switch. Subscribe with: faces billing:subscription:activate --plan ${want}`)
    }
    if (plan === 'team') this.error('Your plan is managed by Faces, so it cannot be switched here.')
    // A switch while set to cancel is charged its proration and the plan still
    // ends at period end, with nothing to say so.
    if (sub.cancel_at_period_end === true) {
      this.error(
        `Your ${planName(plan)} plan is set to cancel, and a switch now would be charged while it still ends.\n` +
          'Keep it first with: faces billing:subscription:activate, then switch.',
      )
    }

    await this.confirmOrRefuse(
      `Switch from ${planName(plan)} to ${planName(want)} (${PLAN_PRICE[want]})? The difference is prorated on your default card.`,
      flags.yes,
    )

    let data: Record<string, unknown>
    try {
      data = await client.post(`/v1/billing/subscription/plan?plan=${want}`, {requireJwt: true}) as Record<string, unknown>
    } catch (err) {
      // A server error can come after the switch went through, and asking
      // again would then switch a plan that is already switched. Read the plan
      // back and say what it actually is.
      if (err instanceof FacesAPIError && err.statusCode >= 500) {
        const now = await client.get('/v1/billing/subscription').catch(() => undefined) as Record<string, unknown> | undefined
        if (now?.plan === want) {
          if (!json) process.stderr.write(`The server answered ${err.statusCode}, but the plan did change.\n`)
          data = {plan: want, previous_plan: plan, status: now.status}
        } else {
          this.error(
            `HTTP ${err.statusCode}: ${err.message}\n` +
              `The plan is still ${planName(now?.plan ?? plan)}. Check with faces billing:subscription before trying again.`,
          )
        }
      } else if (err instanceof FacesAPIError) {
        // Set to cancel since it was read: refused before anything was charged.
        if (err.statusCode === 409 && err.errorCode === 'cancellation_pending') {
          this.error(`HTTP 409: ${err.message}\nKeep it first with: faces billing:subscription:activate, then switch.`)
        }
        if (err.statusCode === 409 && plan === 'free') {
          this.error(`HTTP 409: ${err.message}\nSubscribe with: faces billing:subscription:activate --plan ${want}`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      } else {
        throw err
      }
    }

    if (!json) {
      this.log(`Switched from ${planName(data.previous_plan ?? plan)} to ${planName(data.plan ?? want)}. The new allowances apply now.`)
      this.log('See them with: faces billing:subscription')
    }
    return data
  }

}
