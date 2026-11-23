import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {ReplyCommand, asFlag, faceFlag, faceRef, stateIdFlag} from '../../foreman.js'
import {Loop, named, rank, stripOptions} from '../../refine.js'

export default class PremiseChoices extends ReplyCommand {
  static description =
    'Propose candidates (OR children) for a premise: the face is shown the premise and its inputs, not what ' +
    'already refines it. With no --question the face asks its own first. Each candidate goes through the ' +
    'duplicate check. A test or the human\'s fact has no candidates. Billed per call.'

  static examples = [
    '<%= config.bin %> <%= command.id %> "the menu" --face @home-cook',
    '<%= config.bin %> <%= command.id %> "the menu" --face @home-cook --question "Which three menus suit these guests?"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    ...asFlag,
    ...faceFlag,
    question: Flags.string({description: 'The question the candidates answer. Default: the face asks its own.'}),
    max: Flags.integer({description: 'At most this many candidates (default 8).', min: 1, max: 32}),
    rank: Flags.boolean({description: 'Then rank them (premise:decide).', default: false}),
  }

  static args = {key: Args.string({description: 'The premise the candidates are for.', required: true})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseChoices)
    const client = this.makeClient(flags)
    const id = this.stateId(flags)
    const out: string[] = []
    const L = new Loop(client, id, faceRef(flags.face), flags.as, (l) => out.push(l))
    try {
      // refused before any billed call: a test or the human's fact has no candidates
      const n = (await L.premises())[args.key]
      if (!n) throw new FacesAPIError(404, `no premise "${args.key}" in this state`)
      if (n.role === 'test') throw new FacesAPIError(422, `"${args.key}" is a test: a test has no alternatives; it is settled by its status`)
      if (n.role === null && n.origin === 'human') throw new FacesAPIError(422, `"${args.key}" is the human's word, an axiom: it has no alternatives`)
      if (n.op === 'and') throw new FacesAPIError(422, `"${args.key}" is an AND premise: a premise has one operator, so it takes no OR child`)
      let q = flags.question
      if (!q) {
        q = await L.ownQuestion(args.key)
        out.push(`The face asked: ${q}`)
      }
      const opts = stripOptions(await L.propose(args.key, named(q), flags.max))
      const w = await L.write(args.key, 'or', opts)
      // the candidates are its OR-refinement: a premise with children is proved only once refined;
      // the state records that premise:choices set it, not a hand edit
      if (w.new.length || w.matched.length) await L.edit(args.key, {refinement: 'complete', refined_by: 'choices'})
      out.push(`Wrote ${w.new.length} candidate(s) under "${args.key}"${w.new.length ? ': ' + w.new.map((k) => `"${k}"`).join(', ') : ''}.` +
        (w.matched.length ? ` ${w.matched.length} matched one already there: ${w.matched.map((k) => `"${k}"`).join(', ')}.` : ''))
      if (flags.rank) out.push(...(await rank(L, args.key)))
    } catch (err) {
      if (err instanceof FacesAPIError) {
        process.exitCode = 1
        process.stderr.write([...out, `Stopped (${err.statusCode}): ${err.message}`].join('\n') + '\n')
        return {error: {status: err.statusCode, message: err.message}, calls: L.calls}
      }
      throw err
    }
    const got = await client.stateReply('GET', this.statePath(id, '/premise'), {params: {key: args.key}})
    const text = [...out, `${L.calls} billed call(s).`, '', String(got.data.text ?? '')].join('\n')
    if (!this.jsonEnabled()) this.log(text)
    return {result: out, calls: L.calls, usage: L.usage, text}
  }
}
