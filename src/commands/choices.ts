import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base.js'
import {FacesAPIError} from '../client.js'
import {CHOICES_PATH, MAX_CHOICES, choicesHint, choicesLines, type ChoicesResponse} from '../choices.js'
import {modelProblem} from '../model.js'
import {heldDecisionError, readStateFlags} from '../decisions.js'
import {retryOnceOnWarmUp, sayWarmUp} from '../utils.js'

export default class Choices extends BaseCommand {
  static description =
    'Ask a face what it would do (POST /v1/choices). Name the upstream model, a face and its maestro: ' +
    '@alice:maestro-1, @dana~alice:maestro-1 for a face shared with you, or a composite such as ' +
    '"(@alice | @bob):maestro-1". maestro-1-flash answers sooner and costs 10 times more. ' +
    'Describe the situation with --state (prose, at most ' +
    '3,000 tokens) or --state-id (a state from faces state:create), ask with --question, and the face proposes ' +
    'the options it would weigh, strongest first. Leave --question out and it proposes the question it would ask. ' +
    'Billed on the tokens it processes (see faces models:list --kind upstream). Takes about 10 to 30 seconds.'

  static examples = [
    '<%= config.bin %> <%= command.id %> @alice:maestro-1 --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"',
    '<%= config.bin %> <%= command.id %> @head~socrates:maestro-1 --state "A chain bakery opened across the street."',
    '<%= config.bin %> <%= command.id %> @alice:maestro-1 --state-id fs_STATE_ID --question "What should the shop do?" --max-choices 3',
    '<%= config.bin %> <%= command.id %> "(@alice | @bob):maestro-1-flash" --state-file situation.txt -q "What next?" --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    question: Flags.string({char: 'q', description: 'The question. Leave it out to have the face propose the question it would ask.'}),
    state: Flags.string({description: 'The situation, as prose: at most 3,000 tokens.', exclusive: ['state-file']}),
    'state-file': Flags.string({description: 'Read the situation from this file.', exclusive: ['state']}),
    'state-id': Flags.string({
      description:
        'A state (from faces state:create) as the situation. With --state, the prose is an addendum for this call only: ' +
        'read with the state, never saved to it. Write anything that should persist with faces state:add --premise.',
    }),
    'max-choices': Flags.integer({description: `The most options to return, 1 to ${MAX_CHOICES}. Default 8.`, min: 1, max: MAX_CHOICES}),
  }

  static args = {
    model: Args.string({
      description:
        'The upstream model: @<face>:<maestro>, e.g. @alice:maestro-1. Another account\'s face is @owner~face; ' +
        'a composite is "(@a | @b):maestro-1" (operators | & - ^). No model after it: on choices the upstream model answers.',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Choices)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    const model = args.model.trim()
    const problem = modelProblem(model, 'upstream')
    if (problem) this.error(problem)

    const body: Record<string, unknown> = {model}
    const fail = (m: string): never => this.error(m)
    if (flags.state !== undefined || flags['state-file'] !== undefined) {
      const state = readStateFlags(flags, fail)
      if (typeof state === 'string' && state.trim() === '') this.error('The situation is empty.')
      body.state = state
    }
    if (flags['state-id']) body.state_id = flags['state-id']
    if (body.state === undefined && body.state_id === undefined) {
      this.error('Describe the situation: --state "..." (or --state-file), or --state-id fs_... for a state.')
    }
    if (flags.question !== undefined) {
      if (flags.question.trim() === '') this.error('--question is empty. Leave it out to have the face propose the question.')
      body.instructions = flags.question
    }
    if (flags['max-choices'] !== undefined) body.max_choices = flags['max-choices']

    let data: ChoicesResponse
    try {
      data = (await retryOnceOnWarmUp(async () => {
        const res = await client.post(CHOICES_PATH, {body})
        const held = heldDecisionError(res)
        if (held) throw held
        return res
      }, json ? undefined : sayWarmUp)) as ChoicesResponse
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const hint = choicesHint(err.statusCode, err.message, model)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }

    if (json) return data
    for (const line of choicesLines(data)) this.log(line)
    return data
  }
}
