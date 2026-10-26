import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {FidelityRun, fidelityError, fidelityPost, nextStep} from '../../fidelity.js'
import {seg, usd} from '../../utils.js'

export default class FidelityStart extends BaseCommand {
  static description =
    'Start a fidelity run on a face you own: ten blind turns, scored out of 10. Each turn you send a ' +
    'message, read two answers labelled a and b (one is the face, one a competitor model given the ' +
    'face\'s own writing), and pick the one that sounds more like the person, accepting it or correcting ' +
    'it. The picks must be the person\'s own: an agent shows both answers and passes on the choice it is ' +
    'given, never its own. The score is saved on the face, and a new run replaces it. On Connect or Pro ' +
    'with ChatGPT linked, answers from Codex-eligible models run on the ChatGPT plan; the rest, and grading ' +
    'a correction, is paid from credits. To play it in the terminal, use faces fidelity:run.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice',
    '<%= config.bin %> <%= command.id %> alice --competitor <model>',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    competitor: Flags.string({
      description: 'The chat model the face is compared with (default: the cheapest Codex-eligible chat model)',
    }),
    model: Flags.string({description: 'The model the face answers on (default: its own default model)'}),
  }

  static args = {
    alias: Args.string({description: 'Alias of a face you own', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FidelityStart)
    const client = this.makeClient(flags)

    const body: Record<string, unknown> = {}
    if (flags.competitor) body.competitor = flags.competitor
    if (flags.model) body.model = flags.model

    let run: FidelityRun
    try {
      run = (await fidelityPost(client, `/v1/faces/${seg(args.alias)}/fidelity`, body)) as unknown as FidelityRun
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(fidelityError(err, {alias: args.alias}))
      throw err
    }

    if (this.jsonEnabled()) return run
    this.log(`run:        ${run.run_id}`)
    this.log(`face:       ${run.alias ?? args.alias}`)
    this.log(`competitor: ${run.competitor ?? '-'}`)
    if (run.estimated_usd !== undefined) this.log(`up to:      ${usd(run.estimated_usd)} from credits`)
    this.log('')
    this.log(nextStep(run) ?? '')
    return run
  }
}
