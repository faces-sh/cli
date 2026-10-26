import {BaseCommand} from '../../base.js'
import {clearConfig} from '../../config.js'

export default class AuthLogout extends BaseCommand {
  static description = 'Clear saved credentials'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    await this.parse(AuthLogout)
    clearConfig()
    this.log('Logged out. Credentials cleared.')
    return {status: 'logged_out'}
  }
}
