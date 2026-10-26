import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {table, usd} from '../../utils.js'

export default class FaceStats extends BaseCommand {
  static description = 'Compile and chat stats for all owned faces'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(FaceStats)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/faces/stats')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printTable(data as Record<string, Record<string, unknown>>)
    return data
  }

  /**
   * One row per face, from named fields only: the stats carry more than is
   * worth reading, and some of it is on its way out of the API.
   */
  private printTable(stats: Record<string, Record<string, unknown>>): void {
    const faces = Object.entries(stats ?? {})
    if (faces.length === 0) {
      this.log('No faces.')
      return
    }

    const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : '-')
    const day = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : '-')
    const body = faces.map(([alias, s]) => [
      alias,
      s.compiled === true ? 'yes' : s.compiled === false ? 'no' : '-',
      n(s.compile_tokens_synced),
      day(s.last_synced_at),
      n(s.chat_input_tokens),
      n(s.chat_output_tokens),
      usd(s.chat_total_cost_usd),
    ])
    const cols = ['FACE', 'COMPILED', 'COMPILED TOKENS', 'LAST COMPILED', 'CHAT IN', 'CHAT OUT', 'CHAT COST']
    for (const line of table(cols, body, new Set(['COMPILED TOKENS', 'CHAT IN', 'CHAT OUT', 'CHAT COST']))) this.log(line)
  }
}
