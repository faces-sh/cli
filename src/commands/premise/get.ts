import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, formatFlags, formatOf, stateIdFlag} from '../../foreman.js'

export default class PremiseGet extends ReplyCommand {
  static description =
    'One premise and its branch, numbered as in state:get, then every message linked to it in full (what the ' +
    'human said, notes, evidence). --depth N levels (default all); --up the path from its root down to it; ' +
    '--query a search by meaning limited to its branch. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %> "the dinner is planned" --depth 2',
    '<%= config.bin %> <%= command.id %> "the menu" --up',
    '<%= config.bin %> <%= command.id %> "the menu" --query "allergies"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    ...formatFlags,
    depth: Flags.integer({description: 'How many levels below it, 0 to 50. Default: all.', min: 0, max: 50}),
    up: Flags.boolean({description: 'The path from its root down to it, instead of its branch.', default: false}),
    query: Flags.string({description: 'The premises in its branch that best match this text, by meaning.'}),
    all: Flags.boolean({description: 'Also premises pruned by an earlier version.', default: false}),
  }

  static args = {key: Args.string({description: 'The premise.', required: true})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseGet)
    const client = this.makeClient(flags)
    const params: Record<string, string> = {key: args.key, format: formatOf(flags, this.jsonEnabled())}
    if (flags.depth !== undefined) params.depth = String(flags.depth)
    if (flags.up) params.up = 'true'
    if (flags.query) params.query = flags.query
    if (flags.all) params.all = 'true'
    return this.reply(client, 'GET', this.statePath(this.stateId(flags), '/premise'), {params})
  }
}
