import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {BENCHMARK_RUNS, benchmarkError, followRun, runLines} from '../../benchmark.js'
import {usd} from '../../utils.js'

export default class BenchmarkStart extends BaseCommand {
  static description =
    'Benchmark a face you own against a reference model, on the face\'s own material: over many rounds, ' +
    'which sounds more like the person, by how much, and how sure. The face needs something compiled and ' +
    'a built style. Paid from credits; on Connect or Pro with ChatGPT linked, calls to Codex-eligible models ' +
    'run on the ChatGPT plan. See the price first with --dry-run, and cap a run with --max-spend.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --dry-run',
    '<%= config.bin %> <%= command.id %> alice --rounds 50 --max-spend 5 --wait',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    model: Flags.string({description: 'The model the face answers with (default: chosen by the server; the run reports which)'}),
    'reference-model': Flags.string({description: 'The model to compare the face against (default: one of OpenAI\'s; the run reports which)'}),
    rounds: Flags.integer({description: 'How many rounds to run (1-300, default: 100)', min: 1, max: 300}),
    seed: Flags.integer({description: 'Draw the same rounds as an earlier run, so the two compare. Omit for a fresh draw.'}),
    'max-spend': Flags.string({description: 'A hard ceiling in USD. When it is reached the run stops and reports what it scored.'}),
    'dry-run': Flags.boolean({description: 'Print the estimated price without starting anything', default: false}),
    wait: Flags.boolean({description: 'Wait for the run to finish and print the result', default: false}),
  }

  static args = {
    alias: Args.string({description: 'Alias of a face you own', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(BenchmarkStart)
    const client = this.makeClient(flags)

    const body: Record<string, unknown> = {self_face: args.alias}
    if (flags.model) body.model = flags.model
    if (flags['reference-model']) body.reference_model = flags['reference-model']
    if (flags.rounds !== undefined) body.rounds = flags.rounds
    if (flags.seed !== undefined) body.seed = flags.seed
    if (flags['max-spend'] !== undefined) {
      const cap = Number(flags['max-spend'])
      if (!Number.isFinite(cap) || cap <= 0) this.error(`--max-spend is an amount in USD above 0 (got "${flags['max-spend']}").`)
      body.max_spend_usd = cap
    }
    if (flags['dry-run']) body.dry_run = true

    let data: Record<string, unknown>
    try {
      data = (await client.post(BENCHMARK_RUNS, {body})) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(benchmarkError(err, args.alias))
      throw err
    }

    if (flags['dry-run']) {
      if (this.jsonEnabled()) return data
      this.log(`About ${usd(data.estimated_usd)} for ${data.rounds} rounds on '${args.alias}', from credits.`)
      if (data.note) this.log(String(data.note))
      return data
    }

    const id = String(data.run_id)
    if (!flags.wait) {
      if (this.jsonEnabled()) return data
      this.log(`Started benchmark ${id}.`)
      this.log(`Follow it with: faces benchmark:get ${id} --wait`)
      return data
    }

    const run = await followRun(client, id, (line) => this.jsonEnabled() || process.stderr.write(`  ${line}\n`))
    if (this.jsonEnabled()) return run
    for (const line of runLines(run)) this.log(line)
    return run
  }
}
