import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CONVERSATIONS_PATH, Conversation, conversationHint, conversationLines} from '../../conversation.js'
import {seg} from '../../utils.js'

export default class ConversationGet extends BaseCommand {
  static description =
    'Read a conversation: its face (or any), status, how many turns and items it holds, whether faces ' +
    'read each other\'s causes, and when it expires. Free. See its items with faces conversation:items.'

  static examples = ['<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    conversation_id: Args.string({description: 'Conversation id (from conversation:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ConversationGet)
    const client = this.makeClient(flags)

    let data: Conversation
    try {
      data = (await client.get(`${CONVERSATIONS_PATH}/${seg(args.conversation_id)}`)) as Conversation
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
