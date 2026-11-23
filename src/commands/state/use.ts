import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, writeStateFile} from '../../foreman.js'

export default class StateUse extends ReplyCommand {
  static description =
    'Use a state in this directory: writes .faces/state (or .faces/state.local with --local, which overrides it), ' +
    'so every faces call run here or below finds it. Prints its synopsis. Free.'

  static examples = ['<%= config.bin %> <%= command.id %> fs_STATE_ID', '<%= config.bin %> <%= command.id %> fs_STATE_ID --local']

  static flags = {
    ...BaseCommand.baseFlags,
    local: Flags.boolean({description: 'Write .faces/state.local (yours, not shared) instead of .faces/state.', default: false}),
  }

  static args = {state_id: Args.string({description: 'The state (fs_...).', required: true})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateUse)
    const client = this.makeClient(flags)
    // read it first: a state that is not yours, or has expired, is not written to the file
    const got = await client.stateReply('GET', this.statePath(args.state_id, '/synopsis'), {params: {reply: '1'}})
      .catch((err: Error) => this.error(err.message))
    if (got.ok) {
      const file = writeStateFile(args.state_id, flags.local)
      if (!this.jsonEnabled()) this.log(`${args.state_id} is used here (${file}).`)
    }
    return this.show(got)
  }
}
