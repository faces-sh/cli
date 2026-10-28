import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {heldDecisionError} from '../../decisions.js'
import {CONVERSATIONS_PATH, conversationHint} from '../../conversation.js'
import {retryOnceOnWarmUp, sayWarmUp, seg} from '../../utils.js'

export default class ConversationCompact extends BaseCommand {
  static description =
    'Compact a conversation: a summary of one face\'s position over the conversation, in the face\'s own ' +
    'terms, stored under a compaction id. Pass that id with --compaction on a later request with the same ' +
    'face. A conversation that takes any face needs the face named. Billed at the cause rate on the tokens ' +
    'it reads and writes; on Connect and Pro it counts against the cause allowance. A failed compaction is ' +
    'not charged. A compaction expires 30 days after it is written.'

  static examples = [
    '<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID',
    '<%= config.bin %> <%= command.id %> fs_CONVERSATION_ID alice --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    conversation_id: Args.string({description: 'Conversation id (from conversation:create)', required: true}),
    face: Args.string({
      description:
        'The face to compact, alone (no @model). Needed when the conversation takes any face; a ' +
        'conversation opened with one face compacts that face.',
      required: false,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ConversationCompact)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    const face = args.face?.trim()
    if (face?.includes('@')) this.error(`Compact a face alone, so leave the model off: ${face.slice(0, face.lastIndexOf('@'))}`)

    let data: Record<string, unknown>
    try {
      data = (await retryOnceOnWarmUp(async () => {
        const res = await client.post(`${CONVERSATIONS_PATH}/${seg(args.conversation_id)}/compact`, {body: face ? {model: face} : {}})
        // A compaction that runs long is held open like a cause; a failure after
        // that point arrives inside the 200.
        const held = heldDecisionError(res)
        if (held) throw held
        return res
      }, json ? undefined : sayWarmUp)) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 422 && !face && /takes any face/.test(err.message)) {
          this.error(`HTTP ${err.statusCode}: ${err.message}\nName the face: faces conversation:compact ${args.conversation_id} <face>`)
        }
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!json) {
      if (typeof data.cause === 'string') this.log(data.cause)
      this.log('')
      this.log(`compaction: ${data.compaction_id ?? '-'}`)
      if (data.turns !== undefined) this.log(`turns:      ${data.turns}`)
      if (data.expires_at) this.log(`expires:    ${data.expires_at}`)
      if (data.compaction_id) this.log(`\nUse it with: faces chat:chat ${face ?? '<face>'}@<model> --compaction ${data.compaction_id} -m "..."`)
    }
    return data
  }
}
