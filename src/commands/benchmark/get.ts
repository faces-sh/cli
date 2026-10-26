import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {BENCHMARK_RUNS, BenchmarkRun, benchmarkError, followRun, runLines} from '../../benchmark.js'
import {seg} from '../../utils.js'

export default class BenchmarkGet extends BaseCommand {
  static description =
    'Read a benchmark run: its status, its progress and, once done, the result: which won, the gap and ' +
    'its 95% interval, and the same by length and by medium.'

  static examples = ['<%= config.bin %> <%= command.id %> <run>', '<%= config.bin %> <%= command.id %> <run> --wait']

  static flags = {
    ...BaseCommand.baseFlags,
    wait: Flags.boolean({description: 'Wait for the run to finish', default: false}),
  }

  static args = {
    run_id: Args.string({description: 'Benchmark run id', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(BenchmarkGet)
    const client = this.makeClient(flags)

    let run: BenchmarkRun
    try {
      run = flags.wait
        ? await followRun(client, args.run_id, (line) => this.jsonEnabled() || process.stderr.write(`  ${line}\n`))
        : ((await client.get(`${BENCHMARK_RUNS}/${seg(args.run_id)}`)) as BenchmarkRun)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No benchmark run '${args.run_id}'. List yours with: faces benchmark:list`)
        this.error(benchmarkError(err))
      }
      throw err
    }

    if (run.status === 'failed') process.exitCode = 1
    if (this.jsonEnabled()) return run
    for (const line of runLines(run)) this.log(line)
    return run
  }
}
