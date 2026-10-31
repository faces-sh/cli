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

    type Page = {data?: Array<Record<string, unknown>>; premises?: Record<string, PremiseState>; has_more?: boolean; last_id?: string}
    const all: Array<Record<string, unknown>> = []
    let premises: Record<string, PremiseState> | undefined
    try {
      // oldest first, a page at a time, until the last page. A server that says
      // has_more but gives an empty page, or a last_id it has given before, would
      // send us round forever: stop there and say so.
      let after = ''
      const seenIds = new Set<string>()
      for (;;) {
        const page = (await client.get(
          `${CONVERSATIONS_PATH}/${seg(args.conversation_id)}/items?order=asc&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        )) as Page
        const rows = page.data ?? []
        all.push(...rows)
        premises = page.premises ?? premises
        if (!page.has_more || !page.last_id) break
        if (rows.length === 0 || seenIds.has(page.last_id)) {
          // straight to stderr, so it shows with --json too and stays out of the JSON
          process.stderr.write(`Warning: stopped paging: the server said there were more items but ${rows.length === 0
            ? 'sent an empty page' : `repeated the position ${page.last_id}`}. The list may be incomplete.\n`)
          break
        }
        seenIds.add(page.last_id)
        after = page.last_id
      }
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    const data = {object: 'list', data: all, first_id: all[0]?.id ?? null, last_id: all.at(-1)?.id ?? null,
      has_more: false, premises}
    if (!this.jsonEnabled()) {
      const items = data.data
      if (items.length === 0) this.log('No items yet.')
      for (const line of itemLines(items)) this.log(line)
      this.log('')
      for (const line of premiseLines(data.premises)) this.log(line)
    }
    return data
  }
}
