import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CONVERSATIONS_PATH, conversationHint} from '../../conversation.js'
import {type Synopsis, synopsisLines} from '../../synopsis.js'
import {seg} from '../../utils.js'

export default class StateSynopsis extends BaseCommand {
  static description =
    'What to do next in a state, read from its support graph: the next goal, what blocks it and the action each ' +
    'needs (test, decide, ask, expand or reopen, heaviest first), what changed since an item, and the outline under ' +
    'each goal. Free. Mark goals with --premise-role key=wanted.'

  static examples = [
    '<%= config.bin %> <%= command.id %> fs_STATE_ID',
    '<%= config.bin %> <%= command.id %> fs_STATE_ID --since ci_12 --no-outline',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    since: Flags.string({description: 'Also list the items written after this item id (ci_...), so you read only what is new.'}),
    outline: Flags.boolean({description: 'Print the support tree under each goal. On by default.', default: true, allowNo: true}),
  }

  static args = {
    state_id: Args.string({description: 'State id (from state:create)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StateSynopsis)
    const client = this.makeClient(flags)
    let data: Synopsis
    try {
      data = (await client.get(`${CONVERSATIONS_PATH}/${seg(args.state_id)}/synopsis`,
        flags.since ? {params: {since: flags.since}} : {})) as Synopsis
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = conversationHint(err)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }
    if (!this.jsonEnabled()) for (const line of synopsisLines(data, flags.outline)) this.log(line)
    return data
  }
}
