import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, compact, stateIdFlag} from '../../foreman.js'

export default class PremiseClaim extends ReplyCommand {
  static description =
    'Claim a premise\'s branch (it and everything AND/OR under it, never its inputs) for 30 minutes, or --ttl ' +
    'seconds; a write into it by anyone but <who> (their --as) is refused. Claiming it again renews it. --release ' +
    'releases the claims on it. The session-end hook releases the session\'s claims. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %> "the menu" builder-A',
    '<%= config.bin %> <%= command.id %> "the menu" --release',
    '<%= config.bin %> <%= command.id %> --release --session "$FACES_SESSION"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    release: Flags.boolean({description: 'Release the claims on it (only <who>\'s, when given).', default: false}),
    session: Flags.string({description: 'With --release and no key: release every claim this session took (what the session-end hook runs).', dependsOn: ['release']}),
    ttl: Flags.integer({description: 'How long it holds, in seconds (default 1800, at most 86400).', min: 1, max: 86400}),
  }

  static args = {
    key: Args.string({description: 'The premise.', required: false}),
    who: Args.string({description: 'Who claims it: the name their writes carry as --as.', required: false}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseClaim)
    const client = this.makeClient(flags)
    const id = this.stateId(flags)
    if (flags.release && flags.session && !args.key) return this.reply(client, 'POST', this.statePath(id, '/release-session'), {body: {session: flags.session}})
    if (!args.key) this.error('Name the premise: faces premise:claim "<key>" <who>')
    if (flags.release) return this.reply(client, 'POST', this.statePath(id, '/release'), {body: compact({key: args.key, agent: args.who})})
    if (!args.who) this.error('Name who claims it: faces premise:claim "<key>" <who>')
    return this.reply(client, 'POST', this.statePath(id, '/claim'), {body: compact({key: args.key, agent: args.who, ttl_seconds: flags.ttl})})
  }
}
