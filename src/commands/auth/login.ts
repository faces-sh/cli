import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {saveCredentials, resolveBaseUrl} from '../../config.js'

export default class AuthLogin extends BaseCommand {
  static description = 'Login and save JWT credentials'

  static flags = {
    ...BaseCommand.baseFlags,
    email: Flags.string({description: 'Account email', required: true}),
    password: Flags.string({description: 'Account password. Leave it out to be asked for it, without it showing as you type'}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AuthLogin)
    const password = await this.secretOrPrompt(flags.password, 'password', 'Password')
    const baseUrl = resolveBaseUrl(flags['base-url'])
    const {FacesClient} = await import('../../client.js')
    const client = new FacesClient(baseUrl)

    let data: Record<string, unknown>
    try {
      data = (await client.postNoAuth('/auth/login', {
        email: flags.email,
        password,
      })) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        this.error(`Login failed (${err.statusCode}): ${err.message}`)
      }

      throw err
    }

    // Unwrap StandardResponse envelope if present
    const inner = (data.data ?? data) as Record<string, unknown>
    const token = (inner.access_token ?? inner.token) as string | undefined
    const userId = inner.user_id ?? inner.id ?? (inner.user as Record<string, unknown> | undefined)?.id

    if (!token) this.error(`Unexpected response: ${JSON.stringify(data)}`)

    saveCredentials({token, user_id: userId ? String(userId) : undefined}, baseUrl)
    const result = {status: 'logged_in', user_id: userId}
    if (!this.jsonEnabled()) this.printHuman(result)
    return result
  }
}
