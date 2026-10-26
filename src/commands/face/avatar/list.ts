import {Args} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg, ownsFace} from '../../../utils.js'

interface AvatarVersion {
  version: number
  stale?: boolean
  etag: string
  rows: number
  cols: number
  bytes: number
  seed?: number | null
  created_at?: string | null
}

interface AvatarList {
  alias: string
  owned_by?: string | null
  current_version?: number | null
  versions: AvatarVersion[]
}

export default class FaceAvatarList extends BaseCommand {
  static description =
    'List the avatar versions a face has. Marks which one is served and which no longer match the face ' +
    'as it is compiled now.'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    face_id: Args.string({
      description: 'Face alias, or owner:alias for a face published by or shared from another account',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceAvatarList)
    const client = this.makeClient(flags)

    let data: AvatarList
    try {
      data = (await client.get(`/v1/faces/${seg(args.face_id)}/avatars`)) as AvatarList
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const rows = data.versions ?? []
      // Making or regenerating a picture is the owner's, and it bills.
      const own = (await ownsFace(client, args.face_id)) !== false
      if (rows.length === 0) {
        this.log(`${data.alias} has no generated avatar yet.`)
        if (own) this.log('Make one with: faces face:avatar:make ' + args.face_id + ' --allow-paid')
        return data
      }

      this.log('VERSION  SERVED  MATCHES FACE  GRID      BYTES   CREATED')
      for (const v of rows) {
        const served = v.version === data.current_version ? 'yes' : '-'
        // `stale` means the image no longer reflects what the face knows, which
        // is a reason to regenerate rather than a fault in the file.
        const matches = v.stale === undefined ? '-' : v.stale ? 'no' : 'yes'
        const grid = `${v.cols}x${v.rows}`
        const created = (v.created_at ?? '').slice(0, 10) || '-'
        this.log(
          `${String(v.version).padEnd(7)}  ${served.padEnd(6)}  ${matches.padEnd(12)}  ${grid.padEnd(8)}  ` +
            `${String(v.bytes).padStart(6)}   ${created}`,
        )
      }

      const stale = rows.filter((v) => v.stale).length
      if (stale > 0 && own) {
        this.log('')
        this.log(
          `${stale} version(s) no longer match the face as it is compiled now. Regenerating bills, so this is only ` +
            'worth doing if the picture matters: faces face:avatar:make ' + args.face_id + ' --allow-paid',
        )
      }
    }

    return data
  }
}
