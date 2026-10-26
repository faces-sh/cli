import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg, similarityText} from '../../utils.js'

interface Neighbor {
  face: string
  /** -1 to 1. Rounded to one decimal place when either face is not yours. */
  similarity: number | null
  centroid_updated_at: number
}

interface NeighborsResponse {
  face: string
  direction: string
  k: number
  neighbors: Neighbor[]
}

export default class FaceNeighbors extends BaseCommand {
  static description =
    'Find the most similar or dissimilar owned faces to a given face. The face to compare against may be ' +
    'one of yours, or a published or shared face named as owner:alias; the faces it is ranked against are ' +
    'always your own. The face needs something compiled. Similarity runs from -1 to 1, and is rounded to one ' +
    'decimal place when the face compared against is not yours.'

  static flags = {
    ...BaseCommand.baseFlags,
    k: Flags.integer({
      description: 'Number of results (1-20)',
      default: 5,
      min: 1,
      max: 20,
    }),
    direction: Flags.string({
      description: 'nearest (most similar) or furthest (most dissimilar)',
      options: ['nearest', 'furthest'],
      default: 'nearest',
    }),
  }

  static args = {
    face_id: Args.string({
      description: 'Face alias, or owner:alias for a face published by or shared from another account',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceNeighbors)
    const client = this.makeClient(flags)

    const params: Record<string, string> = {
      k: String(flags.k),
      direction: flags.direction,
    }

    let data: unknown
    try {
      data = await client.get(`/v1/faces/${seg(args.face_id)}/neighbors`, {params})
    } catch (err) {
      // A face with nothing compiled is refused, with the server saying so.
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      const res = data as NeighborsResponse
      const label = res.direction === 'nearest' ? 'Nearest' : 'Most dissimilar'
      this.log(`${label} neighbors to ${res.face} (by overall similarity):`)
      this.log('')
      if (res.neighbors.length === 0) {
        this.log('  (none)')
      } else {
        for (const [i, n] of res.neighbors.entries()) {
          const updated = new Date(n.centroid_updated_at * 1000).toISOString().slice(0, 10)
          this.log(`  ${i + 1}. ${n.face.padEnd(20)} ${similarityText(n.similarity).padEnd(7)} (updated ${updated})`)
        }
      }
    }

    return data
  }
}
