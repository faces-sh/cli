import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'

export default class KeysList extends BaseCommand {
  static description = 'List all API keys (JWT required)'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(KeysList)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/auth/api-keys', {requireJwt: true})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
