import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'

export default class FaceTagAll extends BaseCommand {
  static description = 'List all tags across all your faces'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(FaceTagAll)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/me/tags')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const tags = (data as {tags: string[]}).tags ?? []
      if (tags.length === 0) {
        this.log('(no tags)')
      } else {
        this.log(tags.join(', '))
      }
    }

    return data
  }
}
