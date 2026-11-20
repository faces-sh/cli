import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {SESSIONS_PATH, Session, sessionLines} from '../../session.js'
import {asFace as faceAlone} from '../../model.js'

export default class SessionCreate extends BaseCommand {
  static description =
    'Start a session with a face. A session groups the turns of one conversation with one face: pass its id ' +
    'with --session on chat or decide, then compact it with session:compact. Opening one is free; ' +
    'each turn costs what it costs without one. A session expires 30 days after its last turn. Sessions are now called states: see faces state:create.'

  static examples = [
    '<%= config.bin %> <%= command.id %> @alice',
    '<%= config.bin %> <%= command.id %> "(@alice | @bob)" --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    face: Args.string({
      description: 'The face alone: @alice, @owner~alice, or a composite such as "(@a | @b)". No maestro or model.',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SessionCreate)
    const client = this.makeClient(flags)
    const face = faceAlone(args.face)
    if (/[:/]/.test(face)) this.error(`A session is with a face alone, with no maestro or model: ${face.split(/[:/]/)[0]}`)

    let data: Session
    try {
      data = (await client.post(SESSIONS_PATH, {body: {model: face}})) as Session
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      for (const line of sessionLines(data)) this.log(line)
      if (data.id) this.log(`\nAdd turns with: faces decide ${face}:maestro-1/jev-latest --session ${data.id} --state "..." --question "..."`)
    }
    return data
  }
}
