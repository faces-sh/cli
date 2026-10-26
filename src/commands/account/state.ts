import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'

export default class AccountState extends BaseCommand {
  static description = 'Your plan, balance and onboarding.'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AccountState)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/account/state')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
