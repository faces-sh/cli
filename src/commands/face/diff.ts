import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {similarityText} from '../../utils.js'

/** The overall similarity of two faces. Null when it could not be computed. */
type ScoreMap = {face: number | null}

interface DiffResponse {
  faces: string[]
  similarity: Record<string, Record<string, ScoreMap>>
  centroids_updated_at: Record<string, number>
}

export default class FaceDiff extends BaseCommand {
  static description = 'Compare owned faces pairwise: one overall similarity score for each pair. Every face named needs something compiled.'

  static flags = {
    ...BaseCommand.baseFlags,
    face: Flags.string({
      description: 'Face alias to include (repeatable, min 2)',
      multiple: true,
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(FaceDiff)
    const client = this.makeClient(flags)

    if (flags.face.length < 2) {
      this.error('At least 2 --face values are required')
    }

    const params: Record<string, string> = {faces: flags.face.join(',')}

    let data: unknown
    try {
      data = await client.get('/v1/faces/diff', {params})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const res = data as DiffResponse
      const faces = res.faces
      const fmt = (v: number | null | undefined) => similarityText(v)

      for (let i = 0; i < faces.length; i++) {
        for (let j = i + 1; j < faces.length; j++) {
          const a = faces[i]
          const b = faces[j]
          this.log(`${a}  ↔  ${b}   ${fmt(res.similarity[a][b]?.face)}`)
        }
      }

      this.log('')
      const updated = Object.entries(res.centroids_updated_at)
        .map(([face, ts]) => `${face} ${new Date(ts * 1000).toISOString().slice(0, 10)}`)
        .join(', ')
      this.log(`Updated: ${updated}`)
    }

    return data
  }
}
