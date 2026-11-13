import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {STATES_PATH, Conversation, conversationHint, conversationLines} from '../../conversation.js'
import {seg} from '../../utils.js'

export default class StateGet extends BaseCommand {
  static description =
    'Read a state: its face (or any), status, how many turns and items it holds, whether faces ' +
    'read each other\'s causes, and when it expires. Free. See its items with faces state:items.'

  static aliases = ['conversation:get']

  static examples = ['<%= config.bin %> <%= command.id %> fs_STATE_ID']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    conversation_id: Args.string({description: 'State id (from state:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateGet)
    const client = this.makeClient(flags)

    let data: Conversation
    try {
      data = (await client.get(`${STATES_PATH}/${seg(args.conversation_id)}`)) as Conversation
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) for (const line of conversationLines(data)) this.log(line)
    return data
  }
}
