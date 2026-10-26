import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {fidelityError, getRun, nextStep, runLines, turnLines} from '../../fidelity.js'

export default class FidelityGet extends BaseCommand {
  static description =
    'Read a fidelity run: its progress, its turns and, once finished, its score. Which answer was the ' +
    'face\'s is shown only after the run is finished. --json has every message and answer.'

  static examples = ['<%= config.bin %> <%= command.id %> <run>']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    run_id: Args.string({description: 'Fidelity run id', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FidelityGet)
    const client = this.makeClient(flags)

    let run
    try {
      run = await getRun(client, args.run_id)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(fidelityError(err, {run: args.run_id}))
      throw err
    }

    if (this.jsonEnabled()) return run
    for (const line of runLines(run)) this.log(line)
    const turns = turnLines(run)
    if (turns.length > 0) {
      this.log('')
      for (const line of turns) this.log(line)
    }
    const next = nextStep(run)
    if (next) this.log(`\n${next}`)
    return run
  }
}
