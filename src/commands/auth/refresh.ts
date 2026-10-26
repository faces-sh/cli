import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {resolveBaseUrl, saveCredentials} from '../../config.js'

export default class AuthRefresh extends BaseCommand {
  static description = 'Exchange current JWT for a fresh one'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AuthRefresh)
    const client = this.makeClient(flags)

    let data: Record<string, unknown>
    try {
      data = (await client.post('/auth/refresh', {requireJwt: true})) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`Refresh failed (${err.statusCode}): ${err.message}`)
      throw err
    }

    const token = (data.access_token ?? data.token) as string | undefined
    if (token) {
      saveCredentials({token}, resolveBaseUrl(flags['base-url']))
      this.log('Token refreshed and saved.')
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
