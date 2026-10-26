import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {answerLines, fidelityError, fidelityPost} from '../../fidelity.js'
import {seg} from '../../utils.js'

export default class FidelityTurn extends BaseCommand {
  static description =
    'Send the next turn\'s message on a fidelity run. Prints two answers, a and b, in random order, with ' +
    'nothing saying which is the face. Pick one with faces fidelity:pick before the next turn.'

  static examples = ['<%= config.bin %> <%= command.id %> <run> -m "How was the trip?"']

  static flags = {
    ...BaseCommand.baseFlags,
    message: Flags.string({char: 'm', description: 'Your message for this turn', exclusive: ['file']}),
    file: Flags.string({description: 'Read the message from a file'}),
  }

  static args = {
    run_id: Args.string({description: 'Fidelity run id, from faces fidelity:start', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FidelityTurn)
    const client = this.makeClient(flags)

    let message = flags.message
    if (flags.file) {
      if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
      message = fs.readFileSync(flags.file, 'utf8')
    }
    if (!message?.trim()) this.error('Give the message with -m "..." or --file <path>.')

    let data: Record<string, unknown>
    try {
      data = await fidelityPost(client, `/v1/fidelity/${seg(args.run_id)}/turns`, {message})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(fidelityError(err, {run: args.run_id}))
      throw err
    }

    if (this.jsonEnabled()) return data
    const turn = Number(data.turn)
    for (const line of answerLines(turn, (data.answers ?? {}) as Record<string, unknown>)) this.log(line)
    this.log('')
    this.log(`Pick one: faces fidelity:pick ${args.run_id} a|b [--correction "what they would have said"]`)
    return data
  }
}
