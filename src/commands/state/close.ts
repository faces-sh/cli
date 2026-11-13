import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {STATES_PATH, conversationHint} from '../../conversation.js'
import {seg} from '../../utils.js'

export default class StateClose extends BaseCommand {
  static description =
    'Close a state. A closed state takes no more turns and cannot be read or compacted. Its ' +
    'compactions stay usable until they expire. Free.'

  static aliases = ['conversation:close']

  static examples = ['<%= config.bin %> <%= command.id %> fs_STATE_ID --yes']

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    conversation_id: Args.string({description: 'State id (from state:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateClose)
    const client = this.makeClient(flags)
    await this.confirmOrRefuse(`Close state ${args.conversation_id}? It cannot be reopened.`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`${STATES_PATH}/${seg(args.conversation_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) this.log(`Closed state ${args.conversation_id}.`)
    return data
  }
}
