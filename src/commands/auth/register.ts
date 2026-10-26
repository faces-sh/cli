import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError, FacesClient} from '../../client.js'
import {saveCredentials, resolveBaseUrl} from '../../config.js'

export default class AuthRegister extends BaseCommand {
  static description = 'Create a new Faces account'

  static flags = {
    ...BaseCommand.baseFlags,
    email: Flags.string({description: 'Email address', required: true}),
    password: Flags.string({
      description: 'Password, with at least one digit. Leave it out to be asked for it, without it showing as you type',
    }),
    username: Flags.string({
      description: 'Username: 1-32 characters, starting with a lowercase letter, then lowercase letters, numbers or underscores (no dashes)',
      required: true,
    }),
    plan: Flags.string({
      description:
        'Plan to subscribe to: "free" ($5 activation, then pay as you go), "connect" ($17/mo) or "pro" ' +
        '($49/mo), neither with an activation fee',
      options: ['free', 'connect', 'pro'],
      default: 'free',
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AuthRegister)
    // The server's rules, checked first so a typo is not a validator error.
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(flags.username)) {
      this.error('--username must be 1-32 characters, start with a lowercase letter, and use only lowercase letters, numbers or underscores (no dashes).')
    }
    const password = await this.secretOrPrompt(flags.password, 'password', 'Password')
    if (!/\d/.test(password)) this.error('The password must contain at least one digit.')

    const baseUrl = resolveBaseUrl(flags['base-url'])
    const client = new FacesClient(baseUrl)

    const payload: Record<string, unknown> = {
      email: flags.email,
      password,
      username: flags.username,
      source: 'cli',
    }

    let data: Record<string, unknown>
    try {
      data = (await client.postNoAuth('/auth/register-email', payload)) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        this.error(`Registration failed (${err.statusCode}): ${err.message}`)
      }
      throw err
    }

    // Unwrap StandardResponse envelope if present
    const inner = (data.data ?? data) as Record<string, unknown>
    const token = (inner.access_token ?? inner.token) as string | undefined
    if (token) saveCredentials({token}, baseUrl)

    const result: Record<string, unknown> = {
      status: 'registered',
      user_id: inner.user_id,
    }

    // Get the appropriate checkout URL based on plan
    if (token) {
      const authedClient = new FacesClient(baseUrl, token)

      if (flags.plan === 'connect' || flags.plan === 'pro') {
        // A subscription, with no $5 activation needed
        try {
          const checkoutResp = await authedClient.post(`/v1/billing/checkout?plan=${flags.plan}&source=cli`) as Record<string, unknown>
          result.checkout_url = checkoutResp.checkout_url
          result.plan = flags.plan
          result.amount = flags.plan === 'pro' ? '$49/mo' : '$17/mo'
        } catch (err) {
          if (err instanceof FacesAPIError) {
            result.checkout_error = `Failed to get ${flags.plan === 'pro' ? 'Pro' : 'Connect'} checkout URL: ${err.message}`
          }
        }
      } else {
        // Free plan: $5 activation
        if (inner.activation_checkout_url) {
          result.checkout_url = inner.activation_checkout_url
          result.plan = 'free'
          result.amount = '$5 (added as API credits)'
        } else {
          try {
            const activate = await authedClient.post('/v1/billing/activate') as Record<string, unknown>
            result.checkout_url = activate.checkout_url
            result.plan = 'free'
            result.amount = '$5 (added as API credits)'
          } catch (err) {
            if (err instanceof FacesAPIError) {
              result.checkout_error = `Failed to get activation URL: ${err.message}`
            }
          }
        }
      }
    }

    if (!this.jsonEnabled()) this.printHuman(result)
    return result
  }
}
