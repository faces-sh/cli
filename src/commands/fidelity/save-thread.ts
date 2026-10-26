import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {fidelityError, fidelityPost} from '../../fidelity.js'
import {seg} from '../../utils.js'

export default class FidelitySaveThread extends BaseCommand {
  static description =
    'Save a finished fidelity run\'s conversation as a thread on the face, so it can be compiled. Each turn ' +
    'becomes your message and the reply you settled on: your correction where you made one, otherwise the ' +
    'answer you accepted. Saving again returns the same thread.'

  static examples = ['<%= config.bin %> <%= command.id %> <run>']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    run_id: Args.string({description: 'Fidelity run id', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FidelitySaveThread)
    const client = this.makeClient(flags)

    let data: Record<string, unknown>
    try {
      data = await fidelityPost(client, `/v1/fidelity/${seg(args.run_id)}/save-thread`, {})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(fidelityError(err, {run: args.run_id}))
      throw err
    }

    if (this.jsonEnabled()) return data
    this.log(`${data.created ? 'Saved as' : 'Already saved as'} thread ${data.thread_id}`)
    this.log(`Compile it into the face: faces compile:thread:make ${data.thread_id}`)
    return data
  }
}
