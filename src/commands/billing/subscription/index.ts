import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {allowanceLines, planName} from '../../../billing.js'

export default class BillingSubscription extends BaseCommand {
  static description =
    'Show your plan (free, connect or pro), renewal date, and on a paid plan how much of each ' +
    'allowance is used: causes over 5 hours, the week and the month, and compiling over the month'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingSubscription)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/billing/subscription')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      // The allowances read as a meter, not nested objects.
      const sub = data as Record<string, unknown>
      // A pending cancellation was one line among many, under "status: active"
      // and full meters. Lead with it.
      if (sub.cancel_at_period_end === true && sub.plan !== 'free') {
        const ends = String(sub.current_period_end ?? 'the end of the period').replace('T', ' ').replace(/\.\d+$/, '')
        this.log(`Set to cancel: the ${planName(String(sub.plan))} plan ends ${ends}, then the account moves to Free.`)
        this.log('Keep it with: faces billing:subscription:activate')
        this.log('')
      }

      const hidden = new Set(['allowances', 'rates'])
      const rest = Object.fromEntries(Object.entries(sub).filter(([k]) => !hidden.has(k)))
      this.printHuman(rest)
      const lines = allowanceLines(sub)
      if (lines.length > 0) {
        this.log('')
        for (const line of lines) this.log(line)
      } else if (sub.plan === 'free') {
        this.log('')
        this.log('The Free plan has no allowances: it pays as it goes from credits (faces billing:balance).')
      }
    }

    return data
  }
}
