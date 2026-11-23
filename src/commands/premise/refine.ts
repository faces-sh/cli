import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {ReplyCommand, asFlag, faceFlag, faceRef, stateIdFlag} from '../../foreman.js'
import {Loop, refine, refineTree} from '../../refine.js'

export default class PremiseRefine extends ReplyCommand {
  static description =
    'Break a goal into sub-goals: a fixed loop of billed /v1/choices and /v1/decisions calls. A decision judges ' +
    'what it needs (conditions that must all hold, meanings to pick from, one test, or the human); the face ' +
    'proposes; each condition must pass two judges; a gap check adds what they leave out. A goal rewritten since ' +
    'is checked again against its new value. -r refines what it refines into too, breadth first. Billed per ' +
    'model call; prints how many it made.'

  static examples = [
    '<%= config.bin %> <%= command.id %> "the dinner is planned" --face @home-cook',
    '<%= config.bin %> <%= command.id %> "the dinner is planned" --face @home-cook -r --depth 2',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    ...stateIdFlag,
    ...asFlag,
    ...faceFlag,
    recursive: Flags.boolean({char: 'r', description: 'Refine what it refines into too, breadth first: a branch stops at a test, the human\'s fact or an await; on an OR only the next candidate to try is refined.', default: false}),
    depth: Flags.string({description: 'With -r: how many levels to refine, a whole number from 1, or all for no limit. Default 3. Every level\'s calls are billed.', dependsOn: ['recursive']}),
  }

  static args = {key: Args.string({description: 'The premise to refine.', required: true})}

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PremiseRefine)
    const client = this.makeClient(flags)
    const id = this.stateId(flags)
    const steps: string[] = []
    const L = new Loop(client, id, faceRef(flags.face), flags.as, (l) => steps.push(l))
    let lines: string[]
    const depth = flags.depth === undefined ? 3 : flags.depth.trim().toLowerCase() === 'all' ? Number.POSITIVE_INFINITY : Number(flags.depth)
    if (!(depth === Number.POSITIVE_INFINITY || (Number.isInteger(depth) && depth >= 1))) {
      this.error('--depth is a whole number from 1, or all for no limit')
    }
    const before = flags.recursive ? await balance(client) : undefined
    try {
      if (flags.recursive) {
        const got = await refineTree(L, args.key, depth, (l) => steps.push(l))
        const after = await balance(client)
        const spent = before !== undefined && after !== undefined ? `$${(before - after).toFixed(4)} spent` : 'spend unknown'
        const waits = got.awaits.length ? ' (' + got.awaits.map((k) => `"${k}"`).join(', ') + ')' : ''
        lines = [`Refined ${got.refined.length} premise(s): ${L.calls} billed call(s), ${spent}, ${got.awaits.length} branch(es) stopped on an await${waits}.`]
        if (got.beyond.length) {
          lines.push(`Stopped at depth ${depth}; ${got.beyond.length} premise(s) below it are not refined (${got.beyond.map((k) => `"${k}"`).join(', ')}). ` +
            `Run again with --depth ${depth + 1}, or --depth all for no limit.`)
        }
      } else {
        lines = await refine(L, args.key)
      }
    } catch (err) {
      if (err instanceof FacesAPIError) {
        process.exitCode = 1
        process.stderr.write([...steps, `Stopped (${err.statusCode}): ${err.message}`,
          `${L.calls} billed call(s) made before it stopped; what they wrote is in the state.`].join('\n') + '\n')
        return {error: {status: err.statusCode, message: err.message}, steps, calls: L.calls, usage: L.usage}
      }
      throw err
    }
    const got = await client.stateReply('GET', this.statePath(id, '/premise'), {params: {key: args.key}})
    const view = typeof got.data.text === 'string' ? got.data.text : ''
    const text = flags.recursive
      ? [...steps, '', view, '', ...lines].join('\n')
      : [...steps, ...lines, `${L.calls} billed call(s) (${L.usage.input_tokens} in, ${L.usage.output_tokens} out).`, '', view].join('\n')
    if (!this.jsonEnabled()) this.log(text)
    return {steps, result: lines, calls: L.calls, usage: L.usage, text}
  }
}

/** The account's balance in dollars, to report what a run spent (how far the balance moved), or
 * undefined when it cannot be read. */
async function balance(client: {get: (p: string) => Promise<unknown>}): Promise<number | undefined> {
  try {
    const d = (await client.get('/v1/billing/balance')) as {balance_usd?: number}
    return typeof d.balance_usd === 'number' ? d.balance_usd : undefined
  } catch {
    return undefined
  }
}
