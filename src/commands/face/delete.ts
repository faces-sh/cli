import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CatalogService} from '../../catalog.js'
import {seg, isMeAlias, ME_MISSING} from '../../utils.js'

export default class FaceDelete extends BaseCommand {
  static description = 'Delete a face permanently'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceDelete)
    const client = this.makeClient(flags)

    await this.confirmOrRefuse(`Delete face '${args.face_id}'? This cannot be undone.`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`/v1/faces/${seg(args.face_id)}`, {requireJwt: true})
    } catch (err) {
      if (err instanceof FacesAPIError && err.statusCode === 404 && isMeAlias(args.face_id)) this.error(`HTTP 404: ${err.message}\n${ME_MISSING}`)
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    try {
      const catalog = new CatalogService()
      catalog.deleteFace(args.face_id)
    } catch { /* catalog errors are non-fatal */ }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }

}
