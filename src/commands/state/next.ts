import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CONVERSATIONS_PATH, conversationHint} from '../../conversation.js'
import {type Claim, type Synopsis, nextLines, pickParallel} from '../../synopsis.js'
import {seg} from '../../utils.js'

export default class StateNext extends BaseCommand {
  static description =
    'The work that is ready in a state, for one agent or a swarm. Prints the heaviest ready item, or with ' +
    '--parallel N up to N items that can run at once (none rests on another, they share no unverified premise ' +
    'below them, and they touch no common resource). With --claim, each is leased to that agent so the others ' +
    'leave it alone until the lease ends (--ttl), it is released (faces state:release), or its status changes. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %> fs_STATE_ID',
    '<%= config.bin %> <%= command.id %> fs_STATE_ID --parallel 3 --claim worker-1 --ttl 1800',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    parallel: Flags.integer({description: 'How many items to take at once, one from each parallel group. Default 1.', min: 1, max: 50, default: 1}),
    claim: Flags.string({description: 'Lease each item taken to this agent (a name for it, up to 100 characters).'}),
    ttl: Flags.integer({description: 'With --claim: how long the lease holds, in seconds, 1 to 86400. Default 900.', min: 1, max: 86_400, dependsOn: ['claim']}),
  }

  static args = {
    state_id: Args.string({description: 'State id (from state:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateNext)
    const client = this.makeClient(flags)
    const base = `${CONVERSATIONS_PATH}/${seg(args.state_id)}`
    let syn: Synopsis
    const claimed: Claim[] = []
    const refused: string[] = []
    try {
      syn = (await client.get(`${base}/synopsis`)) as Synopsis
      const picked = pickParallel(syn, flags.parallel)
      if (flags.claim) {
        for (const f of picked) {
          try {
            claimed.push((await client.post(`${base}/claims`, {body: {key: f.key, agent: flags.claim, ...(flags.ttl ? {ttl_seconds: flags.ttl} : {})}})) as Claim)
          } catch (err) {
            // another agent took it between the read and the claim: leave it to them
            if (err instanceof FacesAPIError && err.statusCode === 409) refused.push(`${f.key}: ${err.message}`)
            else throw err
          }
        }
      }
      const taken = flags.claim ? picked.filter((f) => claimed.some((c) => c.key === f.key)) : picked
      if (this.jsonEnabled()) return {object: 'state.next', items: taken, claims: claimed, refused, done: syn.done ?? false}
      for (const line of nextLines(syn, taken, claimed)) this.log(line)
      for (const r of refused) this.log(`not claimed, another agent holds it: ${r}`)
      return {object: 'state.next', items: taken, claims: claimed, refused, done: syn.done ?? false}
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }
  }
}
