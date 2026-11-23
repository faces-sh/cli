import fs from 'node:fs'
import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ReplyCommand, asFlag, compact, keyList, premiseValue, stateIdFlag} from '../../foreman.js'

export default class PremiseAdd extends ReplyCommand {
  static description =
    'Add a premise to the state; fails if the key exists (premise:edit changes one). --and: a sub-goal of that ' +
    'parent (it needs all its AND children). --or: a candidate for it (one proved candidate settles it). --on: ' +
    'inputs it reads (support, not refinement). No --role is a fact, a leaf. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %> "the dinner is planned" "A dinner party for six" --role goal --said "Plan a dinner party for six."',
    '<%= config.bin %> <%= command.id %> "the guests" "Six, one vegan" --and "the dinner is planned" --origin human',
    '<%= config.bin %> <%= command.id %> "each guest can eat each dish" "Pass if ..." --role test --and "the dinner is planned" --on "the menu,the guests"',
    '<%= config.bin %> <%= command.id %> --jsonl premises.jsonl',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    ...asFlag,
    key: Flags.string({description: 'The premise key (instead of the first argument).'}),
    value: Flags.string({description: 'Its value (instead of the second argument): JSON when it is JSON, text otherwise.'}),
    and: Flags.string({description: 'The parent it is a sub-goal of (AND).', exclusive: ['or']}),
    or: Flags.string({description: 'The parent it is a candidate for (OR).', exclusive: ['and']}),
    on: Flags.string({description: 'Inputs it reads: premise keys, comma separated (repeatable). A key holding a comma goes in double quotes.', multiple: true}),
    role: Flags.string({description: 'goal or test. None: a fact, a leaf.', options: ['goal', 'test']}),
    status: Flags.string({description: 'stated, verified, assumed, unresolved or invalidated.'}),
    origin: Flags.string({description: 'Who it comes from: human, agent, tool or web. Default: human with --said, else agent.'}),
    description: Flags.string({description: 'What the premise is, in a line.'}),
    said: Flags.string({description: 'The human\'s words it comes from, as they said them (stored once, linked).'}),
    await: Flags.string({description: 'What it waits on: human, environment, a test\'s key, or none.'}),
    jsonl: Flags.string({description: 'Add many: a file (or - for stdin) with one JSON object per line, each with the fields above (key, value, and, or, on, role, status, origin, description, said, await, as); on is a JSON array of keys or a comma list.'}),
  }

  static args = {
    key: Args.string({description: 'The premise key: plain text, 1 to 120 characters.', required: false}),
    value: Args.string({description: 'Its value: JSON when it is JSON, text otherwise.', required: false}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseAdd)
    const client = this.makeClient(flags)
    const p = this.statePath(this.stateId(flags), '/premises')
    if (flags.jsonl) {
      const raw = flags.jsonl === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(flags.jsonl, 'utf8')
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
      const out: unknown[] = []
      for (const [i, line] of lines.entries()) {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(line) as Record<string, unknown>
        } catch {
          this.error(`--jsonl line ${i + 1} is not JSON: ${line.slice(0, 80)}`)
        }
        // `on` as a JSON array is taken as it is; as text it is a comma list, read as --on reads it
        // (a key holding a comma goes in double quotes)
        if (typeof body.on === 'string') {
          try {
            body.on = keyList([body.on], `--jsonl line ${i + 1}: on`) ?? []
          } catch (err) {
            this.error(err instanceof Error ? err.message : String(err))
          }
        }
        if (i > 0 && !this.jsonEnabled()) this.log('')
        out.push(await this.reply(client, 'POST', p, {body}))
        if (process.exitCode) break
      }
      return out
    }
    const key = flags.key ?? args.key
    const rawValue = flags.value ?? (flags.key === undefined ? args.value : args.key)
    const body = compact({
      key,
      value: rawValue === undefined ? undefined : premiseValue(rawValue),
      and: flags.and,
      or: flags.or,
      on: keyList(flags.on, '--on'),
      role: flags.role,
      status: flags.status,
      origin: flags.origin,
      description: flags.description,
      said: flags.said,
      await: flags.await,
      as: flags.as,
    })
    return this.reply(client, 'POST', p, {body})
  }
}
