import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CONVERSATIONS_PATH, conversationHint} from '../../conversation.js'
import {seg} from '../../utils.js'

export default class StateRelease extends BaseCommand {
  static description = 'Release a claim on a state\'s premise (from faces state:next --claim), so another agent can take it. Free.'

  static examples = ['<%= config.bin %> <%= command.id %> fs_STATE_ID clm_CLAIM_ID']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    state_id: Args.string({description: 'State id (from state:create)', required: true}),
    claim_id: Args.string({description: 'Claim id (clm_..., from state:next --claim)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateRelease)
    const client = this.makeClient(flags)
    let data: unknown
    try {
      data = await client.delete(`${CONVERSATIONS_PATH}/${seg(args.state_id)}/claims/${seg(args.claim_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = err.statusCode === 404 && /claim/.test(err.message) ? 'It has expired, was released, or its premise changed status.' : conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }
    if (!this.jsonEnabled()) this.log(`Released ${args.claim_id}.`)
    return data
  }
}
