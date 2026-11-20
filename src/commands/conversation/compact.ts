import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {heldDecisionError} from '../../decisions.js'
import {CONVERSATIONS_PATH, conversationHint} from '../../conversation.js'
import {retryOnceOnWarmUp, sayWarmUp, seg} from '../../utils.js'
import {asFace as faceAlone} from '../../model.js'

export default class ConversationCompact extends BaseCommand {
  static description =
    'Compact a state: one face\'s position over the state, kept on the server under a compaction id. ' +
    'Pass that id with --compaction on a later request with the same face. A state that takes any face ' +
    'needs the face named. Billed on the tokens it reads and writes; on Connect and Pro it counts against ' +
    'the plan\'s allowance. A failed compaction is not charged. A compaction expires 30 days after it is written.'

  static examples = [
    '<%= config.bin %> <%= command.id %> fs_STATE_ID',
    '<%= config.bin %> <%= command.id %> fs_STATE_ID @alice --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    conversation_id: Args.string({description: 'State id (from state:create)', required: true}),
    face: Args.string({
      description:
        'The face to compact, as @face (or @owner~face), with no model after it. Needed when the state ' +
        'takes any face; a state opened with one face compacts that face.',
      required: false,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ConversationCompact)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    const face = args.face === undefined ? undefined : faceAlone(args.face)
    if (face && /[:/]/.test(face)) this.error(`Compact a face alone, with no maestro or model: ${face.split(/[:/]/)[0]}`)

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
          this.error(`HTTP ${err.statusCode}: ${err.message}\nName the face: faces state:compact ${args.conversation_id} @<face>`)
        }
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!json) {
      this.log(`compaction: ${data.compaction_id ?? '-'}`)
      if (data.turns !== undefined) this.log(`turns:      ${data.turns}`)
      if (data.expires_at) this.log(`expires:    ${data.expires_at}`)
      if (data.compaction_id) this.log(`\nUse it with: faces chat:chat ${face ?? '@<face>'}:maestro-1/<model> --compaction ${data.compaction_id} -m "..."`)
    }
    return data
  }
}
