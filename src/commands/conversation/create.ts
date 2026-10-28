import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {
  CONVERSATIONS_PATH,
  Conversation,
  MAX_CONVERSATION_ITEMS,
  PREMISE_DESCRIPTION_FLAG_DESCRIPTION,
  PREMISE_FLAG_DESCRIPTION,
  clientItems,
  conversationHint,
  conversationLines,
  parsePremises,
} from '../../conversation.js'

export default class ConversationCreate extends BaseCommand {
  static description =
    'Start a conversation. The server keeps the whole conversation: your messages, each face\'s reply with ' +
    'its cause, decisions, and premises (named facts you declare). Pass its id with --conversation on chat, ' +
    'causes or decide and send only what is new. Name a face and the conversation takes that face only; ' +
    'leave it out and it takes any of your faces. Opening one is free; each turn costs what it costs ' +
    'without one. A conversation expires 30 days after it was last used.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice',
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-causes-visible --json',
    '<%= config.bin %> <%= command.id %> alice --premise budget_usd=50000 --premise-description budget_usd="the most we can spend this year"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    'causes-visible': Flags.boolean({
      description:
        'Whether each face reads the other faces\' causes. On by default; --no-causes-visible keeps each ' +
        'face to its own. Matters only in a conversation with several faces.',
      default: true,
      allowNo: true,
    }),
    message: Flags.string({char: 'm', description: 'A first message of yours (repeatable, kept in order).', multiple: true}),
    premise: Flags.string({description: PREMISE_FLAG_DESCRIPTION, multiple: true}),
    'premise-description': Flags.string({description: PREMISE_DESCRIPTION_FLAG_DESCRIPTION, multiple: true}),
  }

  static args = {
    face: Args.string({
      description:
        'The face alone: an alias, owner:alias, or a composite such as "(a | b)". No @model. Leave it out ' +
        'for a conversation that takes any of your faces.',
      required: false,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ConversationCreate)
    const client = this.makeClient(flags)
    const face = args.face?.trim()
    if (face?.includes('@')) this.error(`A conversation is with a face alone: ${face.slice(0, face.lastIndexOf('@'))}`)

    let items: Array<Record<string, unknown>>
    try {
      items = clientItems(flags.message, parsePremises(flags.premise, flags['premise-description']))
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    if (items.length > MAX_CONVERSATION_ITEMS) {
      this.error(`At most ${MAX_CONVERSATION_ITEMS} messages and premises at a time (got ${items.length}). Add the rest with faces conversation:add.`)
    }

    const body: Record<string, unknown> = {causes_visible: flags['causes-visible']}
    if (face) body.model = face
    if (items.length > 0) body.items = items

    let data: Conversation
    try {
      data = (await client.post(CONVERSATIONS_PATH, {body})) as Conversation
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) {
      for (const line of conversationLines(data)) this.log(line)
      if (data.id) this.log(`\nTake a turn with: faces chat:chat ${face ?? '<face>'}@<model> --conversation ${data.id} -m "..."`)
    }
    return data
  }
}
