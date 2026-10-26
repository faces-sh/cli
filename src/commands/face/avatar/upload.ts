import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

interface AvatarUpload {
  alias: string
  source?: string
  cols: number
  rows: number
  source_width?: number | null
  source_height?: number | null
  replaced: boolean
  url: string
}

/**
 * What the route accepts, by file extension.
 *
 * A Blob with no type is sent as application/octet-stream and refused with a
 * 415, so the type has to be set here. Checking the extension locally also
 * means an unsupported file is refused before it is uploaded.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export default class FaceAvatarUpload extends BaseCommand {
  static description =
    'Use your own picture for a face instead of a generated avatar. Free, and it replaces any picture ' +
    'already uploaded.'

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      description: 'Image file to upload: png, jpeg, webp, gif or bmp',
      required: true,
    }),
  }

  static args = {
    face_id: Args.string({description: 'Face alias (must be one of yours)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceAvatarUpload)
    const client = this.makeClient(flags)

    const filePath = path.resolve(flags.file)
    if (!fs.existsSync(filePath)) this.error(`No such file: ${flags.file}`)
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) this.error(`${flags.file} is a directory, not an image.`)
    if (stat.size === 0) this.error(`${flags.file} is empty.`)

    const type = IMAGE_TYPES[path.extname(filePath).toLowerCase()]
    if (!type) {
      this.error(
        `${path.basename(filePath)} is not an image this accepts.\n` +
          `Accepted: ${[...new Set(Object.values(IMAGE_TYPES))].sort().join(', ')}`,
      )
    }

    const form = new FormData()
    form.append('file', new Blob([fs.readFileSync(filePath)], {type}), path.basename(filePath))

    let data: AvatarUpload
    try {
      data = (await client.putForm(`/v1/faces/${seg(args.face_id)}/avatar/upload`, form)) as AvatarUpload
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      this.log(`${data.replaced ? 'Replaced the uploaded picture for' : 'Uploaded a picture for'} ${data.alias}`)
      this.log(`  rendered to a ${data.cols}x${data.rows} grid`)
      if (data.source_width && data.source_height) {
        this.log(`  from ${data.source_width}x${data.source_height}`)
      }

      // The uploaded picture is not served unless it is asked for, which is
      // worth saying here rather than leaving someone to wonder why nothing
      // changed.
      this.log('')
      this.log(`Serve it with: faces face:avatar:get ${args.face_id} --prefer uploaded`)
      this.log(`Remove it with: faces face:avatar:delete ${args.face_id}`)
    }

    return data
  }
}
