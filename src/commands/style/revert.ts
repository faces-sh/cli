import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {VERSIONS_PATH} from '../../style.js'

export default class StyleRevert extends BaseCommand {
  static description =
    'Go back to the style a face had before the last build, whether you ran style:make or it was an ' +
    'automatic build. Two versions are kept per medium, so this is a toggle: running it again returns to ' +
    'where you started. A build after a revert keeps the version you reverted to as its previous one, so ' +
    'reverting never loses the style you chose. A face holds one style per medium, ' +
    'so name which one with --medium when it has more than one. It takes effect ' +
    'immediately, so it asks first.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --yes',
    '<%= config.bin %> <%= command.id %> alice --medium email --yes',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    medium: Flags.string({
      description:
        'Which style to step back, when the face has more than one. See faces style:versions <alias>.',
    }),
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StyleRevert)
    const client = this.makeClient(flags)

    // This writes to a live face the moment it is called. Requiring --yes is
    // not ceremony: the endpoint takes a single field and gives no dry run, so
    // an exploratory call is indistinguishable from a real one.
    if (!flags.yes) {
      this.error(
        `This changes the style '${args.alias}' applies${flags.medium ? ` for ${flags.medium}` : ''}, straight away. ` +
          'Re-run with --yes to confirm.\n' +
          `See what it would go back to: faces style:versions ${args.alias}`,
      )
    }

    const body: Record<string, unknown> = {self_face: args.alias}
    // A medium is required once a face holds more than one style. Sending the
    // flag only when given keeps the legacy single-lineage call unchanged.
    if (flags.medium !== undefined) body.medium = flags.medium

    let data: Record<string, unknown>
    try {
      data = (await client.post(`${VERSIONS_PATH}/revert`, {body})) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No face named '${args.alias}'. It does not exist, or is not yours.`)
        // The server's 409s say exactly what is wrong: more than one style to
        // choose between, or nothing left to step back to. Pass them through
        // and add only the command that answers them.
        if (err.statusCode === 409) {
          this.error(`HTTP 409: ${err.message}\nSee what is there: faces style:versions ${args.alias}`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (this.jsonEnabled()) return data
    const from = data.from_version
    const to = data.to_version
    if (from !== undefined && to !== undefined) {
      this.log(`'${args.alias}' moved from version ${from} back to version ${to}.`)
    } else {
      this.log(`'${args.alias}' reverted.`)
    }
    // Reverting again returns to where you started: it is a toggle between the
    // two kept versions, not a walk backwards. Name the version it goes back to
    // so the user does not have to hold it in their head.
    const back = from === undefined ? '' : ` to return to version ${from}`
    this.log(`Run it again${back}. List versions: faces style:versions ${args.alias}`)
    return data
  }
}
