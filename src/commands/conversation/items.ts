import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CONVERSATIONS_PATH, PremiseState, conversationHint, itemLines, premiseLines} from '../../conversation.js'
import {seg} from '../../utils.js'

export default class ConversationItems extends BaseCommand {
  static description =
    'List a conversation\'s items in order: your messages, each face\'s reply with its cause, decisions ' +
    'with their choice and cause, and premises. Ends with the premises in force now. Free.'

  static examples = [
    '<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID',
    '<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    conversation_id: Args.string({description: 'Conversation id (from conversation:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ConversationItems)
    const client = this.makeClient(flags)

    let data: {data?: Array<Record<string, unknown>>; premises?: Record<string, PremiseState>}
    try {
      data = (await client.get(`${CONVERSATIONS_PATH}/${seg(args.conversation_id)}/items`)) as typeof data
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) {
      const items = data.data ?? []
      if (items.length === 0) this.log('No items yet.')
      for (const line of itemLines(items)) this.log(line)
      this.log('')
      for (const line of premiseLines(data.premises)) this.log(line)
    }
    return data
  }
}
