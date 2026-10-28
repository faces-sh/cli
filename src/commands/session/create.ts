import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {SESSIONS_PATH, Session, sessionLines} from '../../session.js'

export default class SessionCreate extends BaseCommand {
  static description =
    'Start a session with a face. A session groups the turns of one conversation with one face: pass its id ' +
    'with --session on chat, causes or decide, then compact it with session:compact. Opening one is free; ' +
    'each turn costs what it costs without one. A session expires 30 days after its last turn. Sessions are now called conversations: see faces conversation:create.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice',
    '<%= config.bin %> <%= command.id %> "(alice | bob)" --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    face: Args.string({
      description: 'The face alone: an alias, owner:alias, or a composite such as "(a | b)". No @model.',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SessionCreate)
    const client = this.makeClient(flags)
    const face = args.face.trim()
    if (face.includes('@')) this.error(`A session is with a face alone: ${face.slice(0, face.lastIndexOf('@'))}`)

    let data: Session
    try {
      data = (await client.post(SESSIONS_PATH, {body: {model: face}})) as Session
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      for (const line of sessionLines(data)) this.log(line)
      if (data.id) this.log(`\nAdd turns with: faces chat:chat ${face}@<model> --session ${data.id} -m "..."`)
    }
    return data
  }
}
