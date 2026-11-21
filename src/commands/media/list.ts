import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {MEDIA_PATH, mediaLines, mediaOf} from '../../media.js'

export default class MediaList extends BaseCommand {
  static description =
    'List the media (GET /v1/media): the kinds of writing a source can be, each with its description and ' +
    'the subcategories it covers. A document declares one when it is compiled (--medium), styles are built ' +
    'one per medium, and chat chooses one for each request. Send the name exactly: a subcategory such as ' +
    'keynote is not a medium (it is a speech). No login needed.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MediaList)
    const client = this.makeClient(flags)
    let raw: unknown
    try {
      raw = await client.get(MEDIA_PATH, {optionalAuth: true})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }
    const data = mediaOf(raw)
    if (this.jsonEnabled()) return {object: 'list', data}
    for (const line of mediaLines(data)) this.log(line)
    return {object: 'list', data}
  }
}
