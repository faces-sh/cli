import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {FIDELITY_TURNS, fidelityError, fidelityPost, getRun, score10} from '../../fidelity.js'
import {seg} from '../../utils.js'

export default class FidelityPick extends BaseCommand {
  static description =
    'Pick the answer, a or b, that sounds more like the person on the open turn of a fidelity run. ' +
    'Without --correction the pick is accepted as it is; with one, it says what the person would ' +
    'actually have said, and how much it changes the face\'s answer lowers that turn\'s score. The pick ' +
    'must be the person\'s own, not an agent\'s. After the tenth, the run\'s score is saved on the face.'

  static examples = [
    '<%= config.bin %> <%= command.id %> <run> a',
    '<%= config.bin %> <%= command.id %> <run> b --correction "Fine, thanks. Long drive."',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    correction: Flags.string({description: 'What the person would actually have said, if the pick is not quite right', exclusive: ['correction-file']}),
    'correction-file': Flags.string({description: 'Read the correction from a file'}),
    turn: Flags.integer({description: 'The turn to pick for (default: the open one)', min: 1, max: FIDELITY_TURNS}),
  }

  static args = {
    run_id: Args.string({description: 'Fidelity run id', required: true}),
    pick: Args.string({description: 'a or b', required: true, options: ['a', 'b']}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FidelityPick)
    const client = this.makeClient(flags)

    let correction = flags.correction
    if (flags['correction-file']) {
      if (!fs.existsSync(flags['correction-file'])) this.error(`File not found: ${flags['correction-file']}`)
      correction = fs.readFileSync(flags['correction-file'], 'utf8')
    }

    let data: Record<string, unknown>
    try {
      let turn = flags.turn
      if (turn === undefined) {
        const run = await getRun(client, args.run_id)
        if (!run.next) this.error(`This run is finished. Read it with: faces fidelity:get ${args.run_id}`)
        if (run.next.awaiting !== 'choice') {
          this.error(`Turn ${run.next.turn} has no answers to pick from yet. Send its message: faces fidelity:turn ${args.run_id} -m "..."`)
        }
        turn = run.next.turn
      }
      const body: Record<string, unknown> = {pick: args.pick}
      if (correction?.trim()) body.correction = correction
      data = await fidelityPost(client, `/v1/fidelity/${seg(args.run_id)}/turns/${turn}/choice`, body)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(fidelityError(err, {run: args.run_id}))
      throw err
    }

    if (this.jsonEnabled()) return data
    this.log(`turn ${data.turn}: scored ${score10(data.score)}, ${score10(data.score_so_far)} so far`)
    if (data.done) {
      this.log(`\nFinished. Fidelity: ${score10(data.fidelity)} out of ${FIDELITY_TURNS}, saved on the face.`)
      this.log(`See which answers were the face's: faces fidelity:get ${args.run_id}`)
      this.log(`Keep the conversation as a thread, to compile: faces fidelity:save-thread ${args.run_id}`)
    } else {
      this.log(`Next turn: faces fidelity:turn ${args.run_id} -m "..."`)
    }
    return data
  }
}
