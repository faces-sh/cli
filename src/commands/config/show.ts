import {BaseCommand} from '../../base.js'
import {maskedConfig} from '../../config.js'

export default class ConfigShow extends BaseCommand {
  static description = 'Print current config (credentials are masked)'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    await this.parse(ConfigShow)
    const data = maskedConfig()
    if (Object.keys(data).length === 0) {
      this.log('No config found at ~/.faces/config.json')
      return {}
    }

    if (!this.jsonEnabled()) this.log(JSON.stringify(data, null, 2))
    return data
  }
}
