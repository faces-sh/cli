import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {STYLE_FACES_PATH} from '../../style.js'
import {faceStyles, seg} from '../../utils.js'

export default class StyleDelete extends BaseCommand {
  static description =
    "Delete a face's built style. A face holds one per medium, so name which with --medium, or pass " +
    '--all to remove every one. On a face with several, an unscoped delete is refused rather than taking ' +
    'them all. The material a style was built from is always kept, so it can be built again without ' +
    're-uploading; to remove source text use compile:doc:delete, or compile:doc:reset to withdraw it from ' +
    'the face while keeping it.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --medium email',
    '<%= config.bin %> <%= command.id %> alice --all --yes',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    medium: Flags.string({
      description: 'Delete only this medium\'s style, leaving the rest. See faces style:versions <alias>.',
      exclusive: ['all'],
    }),
    all: Flags.boolean({
      description: 'Delete every style the face has. Required when it holds more than one.',
      default: false,
      exclusive: ['medium'],
    }),
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StyleDelete)
    const client = this.makeClient(flags)

    if (!flags.yes) {
      const media = await this.mediaOf(client, args.alias)
      const scope = flags.medium
        ? `its ${flags.medium} style`
        : media.length > 1
          ? `all ${media.length} of its styles (${media.join(', ')})`
          : media.length === 1
            ? `its ${media[0]} style`
            : 'its style'
      const what = `'${args.alias}' will forget ${scope}. Its documents, threads and uploaded material are kept.`
      await this.confirmOrRefuse(`${what}\nDelete?`, false)
    }

    const params = new URLSearchParams()
    if (flags.medium) params.set('medium', flags.medium)
    if (flags.all) params.set('all', 'true')
    const qs = params.toString()

    let data: Record<string, unknown>
    try {
      data = (await client.delete(
        `${STYLE_FACES_PATH}/${encodeURIComponent(args.alias)}${qs ? `?${qs}` : ''}`,
      )) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        // An unscoped delete on a face holding several is refused rather than
        // taking them all. The server names them; add the two ways forward.
        if (err.errorCode === 'style_delete_ambiguous' || err.statusCode === 409) {
          this.error(
            `${err.message}\n` +
              `Name one:  faces style:delete ${args.alias} --medium <medium>\n` +
              `Or all:    faces style:delete ${args.alias} --all\n` +
              `See what it has: faces style:versions ${args.alias}`,
          )
        }
        if (err.errorCode === 'style_medium_unavailable') {
          this.error(`${err.message}\nSee what it has: faces style:versions ${args.alias}`)
        }
        if (err.statusCode === 404) this.error(`No face named '${args.alias}'. It does not exist, or is not yours.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (this.jsonEnabled()) return data
    // The server reports what it actually did, so say that rather than echoing
    // back what was asked for.
    const scoped = data.scoped === true || typeof data.medium === 'string'
    const medium = data.medium as string | undefined
    this.log(
      scoped && medium
        ? `'${args.alias}' has forgotten its ${medium} style. Its other styles and all its source material are untouched.`
        : `'${args.alias}' has forgotten its styles. Its source material is untouched.`,
    )
    this.log(`Build it again with: faces style:make ${args.alias} --all`)
    return data
  }

  /** Media whose styles this delete would remove. Empty if it cannot tell. */
  private async mediaOf(client: ReturnType<typeof this.makeClient>, alias: string): Promise<string[]> {
    try {
      return faceStyles((await client.get(`/v1/faces/${seg(alias)}`)) as {styles?: unknown})
    } catch {
      // Naming the media is a courtesy; failing to fetch them must not block
      // the delete or turn into an error about something else.
      return []
    }
  }

}
