import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, asFlag, stateIdFlag} from '../../foreman.js'

export default class PremiseDelete extends ReplyCommand {
  static description = 'Remove a premise and its edges. Its history keeps it; no status changes, nothing cascades. Free.'

  static examples = ['<%= config.bin %> <%= command.id %> "the old menu"']

  static flags = {...BaseCommand.baseFlags, ...stateIdFlag, ...asFlag}

  static args = {key: Args.string({description: 'The premise to remove.', required: true})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseDelete)
    const client = this.makeClient(flags)
    const params: Record<string, string> = {key: args.key}
    if (flags.as) params.as = flags.as
    return this.reply(client, 'DELETE', this.statePath(this.stateId(flags), '/premises'), {params})
  }
}
