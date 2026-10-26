import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {SESSIONS_PATH, Session, sessionHint, sessionLines} from '../../session.js'
import {seg} from '../../utils.js'

export default class SessionGet extends BaseCommand {
  static description = 'Read a session: its face, status, how many turns it holds, and when it expires. Free.'

  static examples = ['<%= config.bin %> <%= command.id %> fs_SESSION_ID']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    session_id: Args.string({description: 'Session id (from session:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SessionGet)
    const client = this.makeClient(flags)

    let data: Session
    try {
      data = (await client.get(`${SESSIONS_PATH}/${seg(args.session_id)}`)) as Session
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = sessionHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) for (const line of sessionLines(data)) this.log(line)
    return data
  }
}
