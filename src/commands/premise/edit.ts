import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, asFlag, compact, keyList, premiseValue, stateIdFlag} from '../../foreman.js'

export default class PremiseEdit extends ReplyCommand {
  static description =
    'Change a premise; fails if the key does not exist. Only what you give changes. A test run is an edit: ' +
    '--status verified|invalidated --tested <candidate> --evidence "<what the run showed>". Filling a premise is ' +
    '--value with --await none. A goal\'s new value sets its refinement back to incomplete. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %> "each guest can eat each dish" --status verified --tested "the vegan menu" --evidence "every dish checked"',
    '<%= config.bin %> <%= command.id %> "the budget" --value "60 euros" --await none --said "Sixty euros."',
    '<%= config.bin %> <%= command.id %> "the menu" --key "what we serve"',
    '<%= config.bin %> <%= command.id %> "the menu" --note "ask about allergies too"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    ...asFlag,
    value: Flags.string({description: 'Its new value: JSON when it is JSON, text otherwise.'}),
    key: Flags.string({description: 'Rename it to this key; its edges, claims and messages follow.'}),
    status: Flags.string({description: 'stated, verified, assumed, unresolved or invalidated.'}),
    description: Flags.string({description: 'What the premise is, in a line.'}),
    await: Flags.string({description: 'What it waits on: human, environment, a test\'s key, or none.'}),
    tested: Flags.string({description: 'With --status on a test: the candidate the run was on.'}),
    evidence: Flags.string({description: 'What a test run showed (stored as a message).'}),
    note: Flags.string({description: 'A note linked to the premise.'}),
    on: Flags.string({description: 'Replace the inputs it reads: premise keys, comma separated (repeatable).', multiple: true}),
    refinement: Flags.string({description: 'complete or incomplete: whether its refinement is sufficient (what premise:refine records).', options: ['complete', 'incomplete']}),
    said: Flags.string({description: 'The human\'s words behind this change.'}),
  }

  static args = {key: Args.string({description: 'The premise to change.', required: true})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseEdit)
    const client = this.makeClient(flags)
    const body = compact({
      key: args.key,
      value: flags.value === undefined ? undefined : premiseValue(flags.value),
      to: flags.key,
      status: flags.status,
      description: flags.description,
      await: flags.await,
      tested: flags.tested,
      evidence: flags.evidence,
      note: flags.note,
      on: flags.on === undefined ? undefined : (keyList(flags.on, '--on') ?? []),
      refinement: flags.refinement,
      said: flags.said,
      as: flags.as,
    })
    return this.reply(client, 'PATCH', this.statePath(this.stateId(flags), '/premises'), {body})
  }
}
