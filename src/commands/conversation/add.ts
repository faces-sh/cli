import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {
  CONVERSATIONS_PATH,
  MAX_CONVERSATION_ITEMS,
  PREMISE_DESCRIPTION_FLAG_DESCRIPTION,
  PREMISE_FLAG_DESCRIPTION,
  PremiseState,
  StaleDecision,
  clientItems,
  conversationHint,
  itemLines,
  parsePremises,
  premiseLines,
  staleDecisionLines,
} from '../../conversation.js'
import {seg} from '../../utils.js'

export default class ConversationAdd extends BaseCommand {
  static description =
    'Add your own messages and premises to a conversation, without a face answering. Premises go in ' +
    'first, then messages. A newer value of a key replaces it from here on, and every earlier decision ' +
    'made while that key held a different value is listed, so you can choose which to ask again: nothing ' +
    `is decided again for you. At most ${MAX_CONVERSATION_ITEMS} at a time. Free.`

  static examples = [
    '<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID --premise vendor_certified=false',
    '<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID --premise budget_usd=50000 --premise-description budget_usd="the most we can spend this year"',
    '<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID -m "The vendor sent their audit report."',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    message: Flags.string({char: 'm', description: 'A message of yours (repeatable, kept in order).', multiple: true}),
    premise: Flags.string({description: PREMISE_FLAG_DESCRIPTION, multiple: true}),
    'premise-description': Flags.string({description: PREMISE_DESCRIPTION_FLAG_DESCRIPTION, multiple: true}),
  }

  static args = {
    conversation_id: Args.string({description: 'Conversation id (from conversation:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ConversationAdd)
    const client = this.makeClient(flags)

    let items: Array<Record<string, unknown>>
    try {
      items = clientItems(flags.message, parsePremises(flags.premise, flags['premise-description']))
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    if (items.length === 0) this.error('Nothing to add: give a message with -m, or a premise with --premise key=value.')
    if (items.length > MAX_CONVERSATION_ITEMS) {
      this.error(`At most ${MAX_CONVERSATION_ITEMS} messages and premises at a time (got ${items.length}). Split them across calls.`)
    }

    let data: {
      data?: Array<Record<string, unknown>>
      premises?: Record<string, PremiseState>
      decisions_made_under_old_values?: StaleDecision[]
    }
    try {
      data = (await client.post(`${CONVERSATIONS_PATH}/${seg(args.conversation_id)}/items`, {body: {items}})) as typeof data
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) {
      for (const line of itemLines(data.data ?? [])) this.log(line)
      this.log('')
      for (const line of premiseLines(data.premises)) this.log(line)
      const stale = staleDecisionLines(data.decisions_made_under_old_values)
      if (stale.length > 0) {
        this.log('')
        for (const line of stale) this.log(line)
      }
    }
    return data
  }
}
