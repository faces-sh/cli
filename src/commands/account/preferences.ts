import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {chatgptLinked} from '../../style.js'

const VALID_KEYS = ['api_fallback', 'default_model', 'auto_style', 'auto_style_thresholds']
const AUTO_STYLE_VALUES = ['on', 'off', 'default']

export default class AccountPreferences extends BaseCommand {
  static description =
    'View or update account preferences: api_fallback, default_model, auto_style and ' +
    'auto_style_thresholds. auto_style builds each face\'s style on its own once it has enough of its ' +
    'own writing in a medium. It is on by default on Connect and Pro, and off on Free. A build runs at no ' +
    'charge on Connect or Pro with ChatGPT linked, and is otherwise charged to credits, so turning it on ' +
    'without a linked ChatGPT account needs --allow-paid. A build that credit cannot cover does not start, ' +
    'and is tried again later.'

  static flags = {
    ...BaseCommand.baseFlags,
    'allow-paid': Flags.boolean({
      description:
        'Permit turning auto_style on where automatic builds are charged to credits: on Free, and on Connect ' +
        'or Pro without ChatGPT linked. Not needed on Connect or Pro with ChatGPT linked, where they run at no charge.',
      default: false,
    }),
  }

  static args = {
    key: Args.string({description: `Preference key to update (${VALID_KEYS.join(', ')})`}),
    value: Args.string({
      description:
        'New value. auto_style takes on, off or default (the plan\'s own: on for Connect and Pro, off for Free). ' +
        'auto_style_thresholds takes medium=words pairs separated by commas, where words is at least 500 ' +
        'and default puts that medium back, e.g. "email=25000,essay=default".',
    }),
  }

  static examples = [
    'faces account:preferences',
    'faces account:preferences default_model gpt-5.4',
    'faces account:preferences api_fallback true',
    'faces account:preferences auto_style off',
    'faces account:preferences auto_style default',
    'faces account:preferences auto_style on --allow-paid',
    'faces account:preferences auto_style_thresholds "email=25000,text message=default"',
  ]

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(AccountPreferences)
    const client = this.makeClient(flags)

    // If no key provided, show current preferences
    if (!args.key) {
      let data: unknown
      try {
        data = await client.get('/v1/user/preferences')
      } catch (err) {
        if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
        throw err
      }

      if (!this.jsonEnabled()) await this.printPreferences(client, data as Record<string, unknown>)
      return data
    }

    // Update a preference
    if (!args.value) this.error('Provide a value to set.')

    if (!VALID_KEYS.includes(args.key)) {
      this.error(`Unknown preference '${args.key}'. Valid keys: ${VALID_KEYS.join(', ')}`)
    }

    let parsedValue: unknown = args.value
    if (args.key === 'api_fallback') {
      if (args.value !== 'true' && args.value !== 'false') {
        this.error('api_fallback must be "true" or "false"')
      }
      parsedValue = args.value === 'true'
    }

    if (args.key === 'auto_style') {
      if (!AUTO_STYLE_VALUES.includes(args.value)) {
        this.error(`auto_style must be one of: ${AUTO_STYLE_VALUES.join(', ')}`)
      }
      if (args.value === 'on' && !flags['allow-paid']) await this.refuseIfPaid(client)
    }

    if (args.key === 'auto_style_thresholds') parsedValue = this.parseThresholds(args.value)

    let data: unknown
    try {
      data = await client.patch('/v1/user/preferences', {body: {[args.key]: parsedValue}})
    } catch (err) {
      // Free always runs on credits, so fallback cannot be turned off there
      // (and reads true while the account is on Free).
      if (err instanceof FacesAPIError && err.statusCode === 422 && args.key === 'api_fallback' && parsedValue === false) {
        this.error(
          // The server's sentence alone: the client's general guidance for this
          // code is about --oauth-only, which this command was not given.
          `HTTP 422: ${err.message.split('\n')[0]}\nOn the Free plan every request runs on credits, so api_fallback stays on. ` +
            'It can be turned off on Connect or Pro: faces billing:subscription:activate',
        )
      }
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      this.log(`Set ${args.key} = ${args.value}`)
      this.log('')
      await this.printPreferences(client, data as Record<string, unknown>)
    }

    return data
  }

  /**
   * Refuse to turn on something that is charged without being asked to.
   *
   * The same rule as style:make: a build runs at no charge or it does not run
   * unless the caller said otherwise. Turning automatic builds on is that
   * decision made once for every face the account will ever upload to. Only
   * Connect or Pro with ChatGPT linked builds at no charge, so the plan and the
   * link are read rather than assumed. Either one unreadable is treated as
   * charged, since guessing free is the expensive mistake.
   */
  private async refuseIfPaid(client: ReturnType<typeof this.makeClient>): Promise<void> {
    let plan: string | undefined
    try {
      const sub = (await client.get('/v1/billing/subscription')) as Record<string, unknown>
      plan = typeof sub.plan === 'string' ? sub.plan : undefined
    } catch {
      plan = undefined
    }
    if (plan === 'team') return
    const paidPlan = plan === 'connect' || plan === 'pro'
    const linked = paidPlan ? await chatgptLinked(client) : false
    if (paidPlan && linked === true) return
    const name = plan === 'pro' ? 'Pro' : 'Connect'
    this.error(
      (!plan
        ? 'Could not read the plan, so automatic builds may be charged to credits.\n'
        : !paidPlan
          ? `This account is on ${plan === 'free' ? 'the Free plan' : `the ${plan} plan`}, where every automatic build is charged to credits.\n`
          : linked === false
            ? `No ChatGPT account is linked, so on ${name} every automatic build is charged to credits.\n`
            : 'Could not check for a linked ChatGPT account, so automatic builds may be charged to credits.\n') +
        'Re-run with --allow-paid if you mean that. On Connect or Pro with ChatGPT linked they run at no charge: ' +
        (paidPlan ? 'faces auth:connect openai' : 'faces billing:subscription:activate'),
    )
  }

  /** `email=25000,essay=default` into the merge-patch the API wants. */
  private parseThresholds(raw: string): Record<string, number | null> {
    const out: Record<string, number | null> = {}
    for (const part of raw.split(',')) {
      if (!part.trim()) continue
      const at = part.lastIndexOf('=')
      if (at === -1) this.error(`'${part.trim()}' is not medium=words. Example: "email=25000,essay=default"`)
      const medium = part.slice(0, at).trim()
      const value = part.slice(at + 1).trim()
      if (!medium) this.error(`'${part.trim()}' names no medium.`)
      if (value === 'default' || value === 'null') {
        out[medium] = null
        continue
      }
      // The minimum and the set of media are the server's to enforce. It
      // names the known media when one is wrong, which a local copy of the
      // list could only get out of date.
      if (!/^\d+$/.test(value)) this.error(`'${value}' for ${medium} is not a whole number of words, or default.`)
      out[medium] = Number(value)
    }
    if (Object.keys(out).length === 0) this.error('Give at least one medium=words pair.')
    return out
  }

  /**
   * Preferences as a person reads them.
   *
   * `auto_style` is the effective answer and `auto_style_setting` is what was
   * stored, null meaning the plan's default. Printed raw they read as
   * "true" beside "null", which says nothing about why it is on, or whether
   * it costs anything.
   */
  private async printPreferences(
    client: ReturnType<typeof this.makeClient>,
    prefs: Record<string, unknown>,
  ): Promise<void> {
    const shown = new Set(['auto_style', 'auto_style_setting', 'auto_style_thresholds'])
    for (const [k, v] of Object.entries(prefs)) {
      if (shown.has(k)) continue
      this.log(`${k}: ${v === null || v === undefined ? '-' : v}`)
    }

    if (!('auto_style' in prefs)) return

    let plan: string | undefined
    try {
      const sub = (await client.get('/v1/billing/subscription')) as Record<string, unknown>
      plan = typeof sub.plan === 'string' ? sub.plan : undefined
    } catch {
      plan = undefined
    }

    const on = prefs.auto_style === true
    const setting = prefs.auto_style_setting
    const why = setting === null || setting === undefined ? 'the plan\'s default' : 'set by you'
    let cost = ''
    if (on && (plan === 'connect' || plan === 'pro')) {
      const linked = await chatgptLinked(client)
      cost = linked === true
        ? ', at no charge on your linked ChatGPT account'
        : linked === false
          ? ', charged to credits until ChatGPT is linked'
          : ', at no charge with ChatGPT linked, otherwise charged to credits'
    } else if (on && plan && plan !== 'team') {
      cost = ', charged to credits'
    }
    this.log(`auto_style: ${on ? 'on' : 'off'} (${why}${cost})`)

    const thresholds = prefs.auto_style_thresholds as Record<string, unknown> | undefined
    if (thresholds && typeof thresholds === 'object' && Object.keys(thresholds).length > 0) {
      this.log('auto_style_thresholds (words of the face\'s own writing before a build runs):')
      const width = Math.max(...Object.keys(thresholds).map((m) => m.length)) + 1
      for (const [medium, words] of Object.entries(thresholds)) {
        // Listed by the server with the rest, but writing with no particular
        // form has no style of its own, so it is never built on its own.
        const note = medium === 'other' ? '  (never built automatically)' : ''
        this.log(`  ${(medium + ':').padEnd(width)} ${words}${note}`)
      }
    }
  }
}
