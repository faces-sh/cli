import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {clearConfig} from '../../config.js'

export default class ConfigClear extends BaseCommand {
  static description = 'Delete all saved credentials and config'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ConfigClear)

    await this.confirmOrRefuse('Delete all saved credentials?', flags.yes)

    clearConfig()
    this.log('Config cleared.')
    return {status: 'cleared'}
  }

}
