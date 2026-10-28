import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {SESSIONS_PATH, sessionHint} from '../../session.js'
import {seg} from '../../utils.js'

export default class SessionClose extends BaseCommand {
  static description =
    'Close a session. A closed session takes no more turns and cannot be compacted or read. Its ' +
    'compactions stay usable until they expire. Free. Sessions are now called conversations: see faces conversation:close.'

  static examples = ['<%= config.bin %> <%= command.id %> fs_SESSION_ID --yes']

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    session_id: Args.string({description: 'Session id (from session:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SessionClose)
    const client = this.makeClient(flags)
    await this.confirmOrRefuse(`Close session ${args.session_id}? It cannot be reopened.`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`${SESSIONS_PATH}/${seg(args.session_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = sessionHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) this.log(`Closed session ${args.session_id}.`)
    return data
  }
}
