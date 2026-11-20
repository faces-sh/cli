import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {heldDecisionError} from '../../decisions.js'
import {SESSIONS_PATH, sessionHint} from '../../session.js'
import {retryOnceOnWarmUp, sayWarmUp, seg} from '../../utils.js'

export default class SessionCompact extends BaseCommand {
  static description =
    'Compact a session: the face\'s position over the session, kept on the server under a compaction id. ' +
    'Pass that id with --compaction on a later request with the same face, and send only the messages you ' +
    'still want read. Billed on the tokens it reads and writes; on Connect and Pro it counts against the ' +
    'plan\'s allowance. A failed compaction is not charged. ' +
    'A compaction expires 30 days after it is written. Sessions are now called states: see faces state:compact.'

  static examples = [
    '<%= config.bin %> <%= command.id %> fs_SESSION_ID',
    '<%= config.bin %> <%= command.id %> fs_SESSION_ID --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    session_id: Args.string({description: 'Session id (from session:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SessionCompact)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    let data: Record<string, unknown>
    try {
      data = (await retryOnceOnWarmUp(async () => {
        const res = await client.post(`${SESSIONS_PATH}/${seg(args.session_id)}/compact`)
        // A compaction that runs long is held open like a cause; a failure after
        // that point arrives inside the 200.
        const held = heldDecisionError(res)
        if (held) throw held
        return res
      }, json ? undefined : sayWarmUp)) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = sessionHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!json) {
      this.log(`compaction: ${data.compaction_id ?? '-'}`)
      if (data.turns !== undefined) this.log(`turns:      ${data.turns}`)
      if (data.expires_at) this.log(`expires:    ${data.expires_at}`)
      if (data.compaction_id) this.log(`\nUse it with: faces chat:chat @<face>:maestro-1/<model> --compaction ${data.compaction_id} -m "..."`)
    }
    return data
  }
}
