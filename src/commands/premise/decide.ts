import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {ReplyCommand, asFlag, faceFlag, faceRef, stateIdFlag} from '../../foreman.js'
import {Loop, rank} from '../../refine.js'

export default class PremiseDecide extends ReplyCommand {
  static description =
    'Rank a premise\'s candidates: a decision writes each one\'s p, which says which to try first. It never ' +
    'chooses or prunes: the top one is next to try, and its tests settle it; only a failed test run on a ' +
    'candidate, or the human, refutes one. Billed per call.'

  static examples = ['<%= config.bin %> <%= command.id %> "the menu" --face @home-cook']

  static flags = {...BaseCommand.baseFlags, ...stateIdFlag, ...asFlag, ...faceFlag}

  static args = {key: Args.string({description: 'The OR premise whose candidates to rank.', required: true})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseDecide)
    const client = this.makeClient(flags)
    const id = this.stateId(flags)
    const L = new Loop(client, id, faceRef(flags.face), flags.as)
    let out: string[]
    try {
      out = await rank(L, args.key)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        process.exitCode = 1
        process.stderr.write(`Stopped (${err.statusCode}): ${err.message}\n`)
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
