import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, formatFlags, formatOf, stateIdFlag} from '../../foreman.js'

export default class StateGet extends ReplyCommand {
  static description =
    'The whole proof: one line per premise, numbered (1, 1.2, 1.2.1), [x] proved, [ ] open, [-] refuted, the ' +
    'operator on each parent, candidates highest p first; then the last line: proved, refuted or open, the next ' +
    'candidate to try, and what would prove it. --query: the premises that best match a text, by meaning. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --query "dietary needs"',
    '<%= config.bin %> <%= command.id %> --problog > proof.pl',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    ...formatFlags,
    query: Flags.string({description: 'The premises that best match this text, by meaning.'}),
    all: Flags.boolean({description: 'Also premises pruned by an earlier version.', default: false}),
  }

  static args = {id: Args.string({description: 'The state (fs_...). Default: .faces/state here or above.', required: false})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateGet)
    const client = this.makeClient(flags)
    const params: Record<string, string> = {format: formatOf(flags, this.jsonEnabled())}
    if (flags.query) params.query = flags.query
    if (flags.all) params.all = 'true'
    return this.reply(client, 'GET', this.statePath(this.stateId(flags, args.id), '/proof'), {params})
  }
}
