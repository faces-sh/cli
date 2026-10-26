import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {BENCHMARK_RUNS, BenchmarkRun, benchmarkError} from '../../benchmark.js'
import {table} from '../../utils.js'

export default class BenchmarkList extends BaseCommand {
  static description = 'List your benchmark runs, newest first.'

  static flags = {
    ...BaseCommand.baseFlags,
    face: Flags.string({description: 'Only runs on this face'}),
    limit: Flags.integer({description: 'How many to list (1-100, default: 20)', default: 20, min: 1, max: 100}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BenchmarkList)
    const client = this.makeClient(flags)

    const params = new URLSearchParams({limit: String(flags.limit)})
    if (flags.face) params.set('self_face', flags.face)
    let data: {runs?: BenchmarkRun[]}
    try {
      data = (await client.get(`${BENCHMARK_RUNS}?${params}`)) as {runs?: BenchmarkRun[]}
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(benchmarkError(err))
      throw err
    }

    if (this.jsonEnabled()) return data
    const runs = data.runs ?? []
    if (runs.length === 0) {
      this.log(`No benchmark runs${flags.face ? ` on '${flags.face}'` : ''}. Price one with: faces benchmark:start <alias> --dry-run`)
      return data
    }
    const rows = runs.map((r) => [
      r.run_id,
      r.self_face ?? '-',
      r.reference_model ?? '-',
      r.status ?? '-',
      String(r.result?.winner ?? '-'),
      String(r.created_at ?? '').slice(0, 10) || '-',
    ])
    for (const line of table(['RUN', 'FACE', 'REFERENCE', 'STATUS', 'WINNER', 'STARTED'], rows)) this.log(line)
    return data
  }
}
