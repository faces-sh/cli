import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class FaceAvatarGet extends BaseCommand {
  static description =
    'Download a face avatar as an image file. Reading one is free; only generating a new version bills.'

  static flags = {
    ...BaseCommand.baseFlags,
    size: Flags.string({
      description: 'Dot grid across: sm (32), md (64) or lg (128). Coarser sizes are exact averages of the stored grid.',
      options: ['sm', 'md', 'lg'],
    }),
    format: Flags.string({description: 'Image format', options: ['png', 'svg'], default: 'png'}),
    width: Flags.integer({description: 'Render width in pixels (32-2048). Defaults to 9 per dot.', min: 32, max: 2048}),
    version: Flags.integer({description: 'A specific version. Omit for the one being served.', min: 1}),
    prefer: Flags.string({
      description:
        "uploaded serves the owner's own picture when there is one, falling back to the generated avatar. " +
        'organic always serves the generated one.',
      options: ['organic', 'uploaded'],
    }),
    out: Flags.string({description: 'Where to write the file. Defaults to <alias>-avatar-v<version>.<ext> here.'}),
  }

  static args = {
    face_id: Args.string({
      description: 'Face alias, or owner:alias for a face published by or shared from another account',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceAvatarGet)
    const client = this.makeClient(flags)

    const params = new URLSearchParams()
    params.set('format', flags.format)
    if (flags.size) params.set('size', flags.size)
    if (flags.width !== undefined) params.set('width', String(flags.width))
    if (flags.version !== undefined) params.set('v', String(flags.version))
    if (flags.prefer) params.set('prefer', flags.prefer)

    let result
    try {
      result = await client.getBinary(
        `/v1/faces/${seg(args.face_id)}/avatar?${params.toString()}`,
      )
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) {
          this.error(
            `No avatar for '${args.face_id}'. See what it has with: faces face:avatar:list ${args.face_id}`,
          )
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    // What came back, as the server reported it. This is the only place that
    // says which version and whether it still matches the face, so a caller
    // who asked for the current one learns what current meant.
    const h = result.headers
    const served = h['x-avatar-version']
    const source = h['x-avatar-source']
    const stale = h['x-avatar-stale']

    const ext = flags.format === 'svg' ? 'svg' : 'png'
    const safe = args.face_id.replace(/[^a-zA-Z0-9_-]/g, '-')
    // An uploaded picture has no generated version number, so naming the file
    // after one would invent it.
    const which = source === 'uploaded' ? 'uploaded' : `v${served ?? 'current'}`
    const outPath = flags.out ?? path.join(process.cwd(), `${safe}-avatar-${which}.${ext}`)

    try {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), {recursive: true})
      fs.writeFileSync(outPath, result.bytes)
    } catch (err) {
      this.error(`Could not write ${outPath}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const report = {
      alias: args.face_id,
      path: path.resolve(outPath),
      bytes: result.bytes.length,
      content_type: result.contentType,
      version: served ? Number(served) : null,
      source: source ?? null,
      stale: stale === undefined ? null : stale === 'true',
      cols: h['x-avatar-cols'] ? Number(h['x-avatar-cols']) : null,
      width: h['x-avatar-width'] ? Number(h['x-avatar-width']) : null,
      owner: h['x-avatar-owner'] ?? null,
      etag: h.etag ?? null,
    }

    if (!this.jsonEnabled()) {
      this.log(`Saved ${report.path}`)
      this.log(`  ${report.bytes.toLocaleString()} bytes, ${report.content_type}`)
      this.log(
        source === 'uploaded'
          ? "  the owner's uploaded picture, not a generated avatar"
          : source === 'default'
            // The placeholder every face has before a picture exists; calling
            // it a generated avatar of unknown version said the opposite.
            ? '  the default placeholder: no avatar has been generated or uploaded yet'
            : `  generated avatar, version ${report.version ?? 'unknown'}`,
      )
      if (report.stale === true) {
        this.log('  This image no longer matches the face as it is compiled now.')
        this.log(`  A current one has to be generated, which bills: faces face:avatar:make ${args.face_id} --allow-paid`)
      }
    }

    return report
  }
}
