import {Args, Flags} from '@oclif/core'
import {createInterface, Interface} from 'node:readline'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {FIDELITY_TURNS, FidelityRun, answerLines, fidelityError, fidelityPost, getRun, runLines, score10, turnLines} from '../../fidelity.js'
import {seg, usd} from '../../utils.js'

export default class FidelityRunCommand extends BaseCommand {
  static description =
    'Play a fidelity run in the terminal: ten turns of writing a message, reading answers a and b, and ' +
    'picking the one that sounds more like the person, with an optional correction. Needs a person at ' +
    'the keyboard; without a terminal, use fidelity:start, fidelity:turn and fidelity:pick. Resume a run ' +
    'with --run.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice',
    '<%= config.bin %> <%= command.id %> alice --run <run>',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    competitor: Flags.string({description: 'The chat model the face is compared with (default: the cheapest Codex-eligible chat model)'}),
    model: Flags.string({description: 'The model the face answers on (default: its own default model)'}),
    run: Flags.string({description: 'Resume this run instead of starting one', exclusive: ['competitor', 'model']}),
  }

  static args = {
    alias: Args.string({description: 'Alias of a face you own', required: true}),
  }

  private rl?: Interface

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FidelityRunCommand)
    if (this.jsonEnabled() || !process.stdin.isTTY) {
      this.error('fidelity:run needs a person at a terminal. Without one, use fidelity:start, fidelity:turn and fidelity:pick.')
    }
    const client = this.makeClient(flags)
    this.rl = createInterface({input: process.stdin, output: process.stderr})

    try {
      let run: FidelityRun
      if (flags.run) {
        run = await getRun(client, flags.run)
      } else {
        const body: Record<string, unknown> = {}
        if (flags.competitor) body.competitor = flags.competitor
        if (flags.model) body.model = flags.model
        run = (await fidelityPost(client, `/v1/faces/${seg(args.alias)}/fidelity`, body)) as unknown as FidelityRun
        this.log(`Run ${run.run_id} against ${run.competitor ?? 'the competitor'}, up to ${usd(run.estimated_usd)} from credits.`)
      }
      const id = run.run_id
      this.log('Each turn, pick the answer that sounds more like the person. Ctrl-C stops; --run resumes.\n')

      while (run.next) {
        const n = run.next.turn
        if (run.next.awaiting === 'message') {
          const message = await this.ask(`Turn ${n} of ${FIDELITY_TURNS}, your message: `)
          if (!message.trim()) continue
          process.stderr.write('Waiting for both answers...\n')
          const t = await fidelityPost(client, `/v1/fidelity/${seg(id)}/turns`, {message})
          this.log('')
          for (const line of answerLines(n, (t.answers ?? {}) as Record<string, unknown>)) this.log(line)
          this.log('')
        }
        let pick = ''
        while (pick !== 'a' && pick !== 'b') pick = (await this.ask('Which sounds more like them, a or b? ')).trim().toLowerCase()
        const correction = await this.ask('What would they actually have said? (Enter to accept it as it is) ')
        const body: Record<string, unknown> = {pick}
        if (correction.trim()) body.correction = correction
        const c = await fidelityPost(client, `/v1/fidelity/${seg(id)}/turns/${n}/choice`, body)
        this.log(`Turn ${n} scored ${score10(c.score)}, ${score10(c.score_so_far)} so far.\n`)
        run = await getRun(client, id)
      }

      for (const line of runLines(run)) this.log(line)
      this.log('')
      for (const line of turnLines(run)) this.log(line)
      if (!run.thread_id) {
        const save = await this.ask('\nSave the conversation as a thread on the face, to compile? [y/N] ')
        if (save.trim().toLowerCase() === 'y') {
          const s = await fidelityPost(client, `/v1/fidelity/${seg(id)}/save-thread`, {})
          this.log(`Saved as thread ${s.thread_id}. Compile it: faces compile:thread:make ${s.thread_id}`)
        }
      }
      return run
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(fidelityError(err, {run: flags.run, alias: args.alias}))
      throw err
    } finally {
      this.rl.close()
    }
  }

  private ask(question: string): Promise<string> {
    return new Promise((resolve) => this.rl!.question(question, resolve))
  }
}
