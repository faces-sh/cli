import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base.js'
import {FacesAPIError, missingFieldsNote} from '../client.js'
import {conversationFields, conversationTurnFlags} from '../conversation.js'
import {
  DECISION_MODELS,
  decisionModels,
  DECISION_FORMATS,
  fromOpenAIAnswers,
  toOpenAIDecision,
  questionsProblem,
  MAX_WARM_UP_WAIT_S,
  QUESTION_TYPES,
  causeLines,
  decisionLines,
  type DecisionCauses,
  heldDecisionError,
  readStateFlags,
  readQuestionFlags,
  warmUpWait,
} from '../decisions.js'
import {compileHint, reasoningHeading, sayWarmUp, SESSION_FLAG_DESCRIPTION, COMPACTION_FLAG_DESCRIPTION} from '../utils.js'

/** Decision models served on /v1/decisions in OpenAI's format and refused on /v1/systemone. */
const OPENAI_FORMAT_ONLY = ['gpt-6-luna'] as const

export default class Decide extends BaseCommand {
  static description =
    'Ask what a face would decide. Describe a situation, ask typed questions about it, and get back numbers, ' +
    'as this face: a yes-or-no (noul), a pick between options (choice), or a place on a graded scale (score). ' +
    'Chat gives you what a face would say; this gives you what it would decide, for routing, simulations or ' +
    'panels. The face\'s cause for each question guides the decision model\'s (--model) answer. A face\'s ' +
    'answer takes about 10 to 20 seconds; one that runs long is held open by the server and can take a ' +
    'minute or more. --baseline asks the decision model alone (no-face baseline), in about a second: the ' +
    'number to compare a face\'s answer against. Name a face and ask no questions for its cause alone. On ' +
    'Connect and Pro the cause counts against the plan\'s allowance and the decision model is paid from ' +
    'credits; on Free both bill per token. A face needs something compiled.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --state "A colleague asks you to sign a grant proposal you have not read, due in an hour." ' +
      '--question "Does the speaker sign?" --option yes="signs it as asked" --option no="declines to sign" ' +
      '--option later="asks for time to read it first"',
    '<%= config.bin %> <%= command.id %> alice --state-file situation.txt --question "Is the speaker irritated?"',
    '<%= config.bin %> <%= command.id %> alice --state-file situation.txt --question "How firm is the reply?" ' +
      '--level yields --level hedges --level firm --show-cause',
    '<%= config.bin %> <%= command.id %> --baseline --model clef-flash --state-file situation.txt --questions-file questions.json',
    '<%= config.bin %> <%= command.id %> alice --state-file situation.txt',
    '<%= config.bin %> <%= command.id %> alice --state-file situation.json --questions-file questions.json --model clef --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    state: Flags.string({
      description:
        'The situation the face is responding to, as plain text, up to 60,000 characters. Write it the way ' +
        'the face would hear it: it is read as the turn the face is answering.',
      exclusive: ['state-file'],
    }),
    'state-file': Flags.string({
      description:
        'Read the situation from this file instead of --state. A .json file is sent as the JSON it holds, ' +
        'so the situation can be an object or an array.',
      exclusive: ['state'],
    }),
    question: Flags.string({
      description:
        'One question to ask. Its type follows from what comes with it: --option makes it a choice, --level a ' +
        'score, and neither a yes-or-no (noul). For several questions, use --questions-file.',
      exclusive: ['questions-file'],
    }),
    type: Flags.string({
      description: 'The type of --question, when you would rather say it than leave it to --option and --level.',
      options: [...QUESTION_TYPES],
      dependsOn: ['question'],
    }),
    option: Flags.string({
      description:
        'An option for a choice, as name="description", or a bare name (repeatable, at least two). The name is ' +
        'what comes back; the description is what the answer is judged against, so make it specific: ' +
        '"declines to sign", not "no". Keep the options mutually exclusive, because the probability is split ' +
        'between them.',
      multiple: true,
      dependsOn: ['question'],
      exclusive: ['level'],
    }),
    level: Flags.string({
      description:
        'A level of a score, described (repeatable, 2 to 10, lowest first). The answer is the expected level, ' +
        'from 0 for the first to one less than the number of levels.',
      multiple: true,
      dependsOn: ['question'],
      exclusive: ['option'],
    }),
    id: Flags.string({
      // No oclif default: one would count as given, and trip dependsOn on
      // every --questions-file call.
      description: 'Key for the --question in the result (default: answer)',
      dependsOn: ['question'],
    }),
    'questions-file': Flags.string({
      description:
        'A JSON file of 1 to 32 questions, in the API\'s own shape: {"<id>": {"type": "noul" | "choice" | ' +
        '"score", "instructions": "...", "criteria": ...}}. A choice\'s criteria are {"<option>": ' +
        '"<description>" or null}; a score\'s are a list of 2 to 10 levels, lowest first; a noul\'s are optional, ' +
        '{"true": "...", "false": "..."}.',
      exclusive: ['question'],
    }),
    model: Flags.string({
      description:
        'The decision model: the model that turns the situation into probabilities, as opposed to a ' +
        'generative model that writes text. Checked against the decision models the API lists: ' +
        'jev-latest, clef, clef-flash and gpt-6-luna today. gpt-6-luna answers in OpenAI\'s format only, ' +
        'so it uses --format openai.',
      default: 'jev-latest',
    }),
    baseline: Flags.boolean({
      description:
        'Ask the decision model alone, with no face: the no-face baseline. Costs only the decision model.',
      default: false,
    }),
    'show-cause': Flags.boolean({
      description:
        'Also show the face\'s cause, one per question when there are several. Printed to stderr ahead of ' +
        'the answers. It is always in --json, as cause and causes.',
      default: false,
    }),
    ...conversationTurnFlags({exclusive: ['baseline']}),
    session: Flags.string({description: SESSION_FLAG_DESCRIPTION, exclusive: ['baseline']}),
    compaction: Flags.string({description: COMPACTION_FLAG_DESCRIPTION, exclusive: ['baseline']}),
    format: Flags.string({
      description:
        'The request shape: systemone (default, TypeSafe Jev\'s System One) or openai (OpenAI\'s Decisions ' +
        'format). The answers are the same; --json returns the chosen format\'s own shape.',
      options: [...DECISION_FORMATS],
      default: 'systemone',
    }),
    retry: Flags.boolean({
      description:
        'If the server answers 503 with the seconds to wait, wait exactly that and ask again, for up to ' +
        `${MAX_WARM_UP_WAIT_S / 60} minutes in all. On by default; --no-retry returns the 503 straight away.`,
      default: true,
      allowNo: true,
    }),
  }

  static args = {
    face: Args.string({description: 'Face alias to answer as, a saved composite, or a formula such as "(a | b)". Leave it out with --baseline.'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Decide)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (flags.baseline && args.face) this.error('--baseline asks with no face, so leave the face out.')
    if (!flags.baseline && !args.face) this.error('Name a face to ask, or pass --baseline to ask with none.')

    let turn: Record<string, unknown> = {}
    try {
      turn = conversationFields(flags)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    const state = this.readState(flags)
    const questions = this.readQuestions(flags)
    if (!questions && flags.baseline) this.error('--baseline answers questions, so ask one with --question or --questions-file.')
    if (questions) {
      const problem = questionsProblem(questions, !flags.baseline,
        (OPENAI_FORMAT_ONLY as readonly string[]).includes(flags.model.toLowerCase()))
      if (problem) this.error(problem)
      // The model is only used to answer questions.
      this.models = await decisionModels(client)
      // The server matches the id exactly, so send the catalog's spelling.
      const match = this.models.find((m) => m.toLowerCase() === flags.model.toLowerCase())
      if (!match) this.error(`'${flags.model}' is not a decision model. The decision models are: ${this.models.join(', ')}.`)
      flags.model = match
      // OpenAI's Decisions model is served only in OpenAI's format.
      if ((OPENAI_FORMAT_ONLY as readonly string[]).includes(match)) {
        if (this.argv.some((a) => a === '--format=systemone' || a === 'systemone')) {
          this.error(`${match} answers in OpenAI's format only. Use --format openai, or leave --format out.`)
        }
        flags.format = 'openai'
      }
    }

    // The server takes the part after @ as the decision model. The decision
    // model alone is the no-face baseline, and the face alone, with no
    // questions, is its cause and nothing else.
    const face = args.face
    const model = questions ? (face ? `${face}@${flags.model}` : flags.model) : face
    let body: Record<string, unknown> = questions ? {model, state, questions} : {model, state}
    if (flags.format === 'openai') {
      try {
        body = toOpenAIDecision(model, state, questions)
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err))
      }
    }
    if (flags.session) body.session = flags.session
    if (flags.compaction) body.compaction = flags.compaction
    Object.assign(body, turn)

    if (!json) {
      process.stderr.write(
        !questions
          ? `Asking ${face} for its cause alone, with no questions.\n`
          : face
            ? `Asking ${face}. Decision model: ${flags.model}. This usually takes 10 to 20 seconds, sometimes a minute or more.\n`
            : `Asking the decision model alone (no-face baseline). Decision model: ${flags.model}.\n`,
      )
    }

    let data: DecisionCauses & {answers?: Record<string, unknown>}
    try {
      data = (await this.ask(client, body, flags.retry, json, flags.format === 'openai' ? '/v1/decisions' : '/v1/systemone')) as typeof data
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(this.explain(err, face, flags.model))
      throw err
    }

    // Say plainly when a field this relies on is missing, rather than printing
    // an empty line: the API renames fields as it goes, and the fix is usually
    // an update. With no face there is no cause to expect.
    const expected = [...(questions ? ['answers'] : []), ...(face ? ['cause'] : [])]
    const missing = missingFieldsNote(data, expected)
    if (missing && !json && !questions) this.error(missing)
    if (missing) process.stderr.write(`${missing}\n`)

    if (json) return data
    if (!questions) {
      this.log(data.cause ?? '')
      return data
    }
    const cause = causeLines(data, Object.keys(questions))
    if (flags['show-cause'] && cause.length > 0 && face) process.stderr.write(`${reasoningHeading(face)}\n${cause.join('\n')}\n\n`)
    const answers = flags.format === 'openai' ? fromOpenAIAnswers(data.answers, questions) : (data.answers ?? {})
    for (const line of decisionLines(answers)) this.log(line)
    return data
  }

  /**
   * Send the request, and if the server answers 503 naming a wait, wait that
   * long and ask again.
   *
   * Such a refusal comes before any work, so asking again costs nothing, and
   * the wait is the server's number exactly. Anything else, including a 503
   * that names no wait, goes straight back to the caller.
   */
  private async ask(
    client: ReturnType<typeof this.makeClient>,
    body: Record<string, unknown>,
    retry: boolean,
    json: boolean,
    endpoint: string,
  ): Promise<unknown> {
    let waited = 0
    for (;;) {
      try {
        // Jev's System One format (`state`, questions keyed by id) is served at /v1/systemone,
        // and OpenAI's Decisions format at /v1/decisions; each refuses the other with a 422.
        //
        // No client timeout is set, and none may be under 60s: a slow decision
        // is held open past 40s with keep-alive spaces before its JSON, and
        // Node's own limits (300s for the headers, 300s between body bytes)
        // are reset by every one of them.
        const data = await client.post(endpoint, {body})
        // A held call that failed is a 200 carrying the refusal.
        const held = heldDecisionError(data)
        if (held) throw held
        return data
      } catch (err) {
        if (!(err instanceof FacesAPIError) || !retry || err.retryable === false) throw err
        const wait = warmUpWait(err.statusCode, err.retryAfter, waited)
        if (wait === undefined) throw err
        if (!json) sayWarmUp(wait)
        await new Promise((r) => setTimeout(r, wait * 1000))
        waited += wait
      }
    }
  }

  private readState(flags: {state?: string; 'state-file'?: string}): unknown {
    return readStateFlags(flags, (m) => this.error(m))
  }

  private readQuestions(flags: {
    question?: string
    type?: string
    option?: string[]
    level?: string[]
    id?: string
    'questions-file'?: string
  }): Record<string, unknown> | undefined {
    return readQuestionFlags(flags, (m) => this.error(m))
  }

  private models?: string[]

  /** The refusal, with what to do about it. */
  private explain(err: FacesAPIError, face: string | undefined, model: string): string {
    const head = `HTTP ${err.statusCode}: ${err.message}`
    switch (err.statusCode) {
      case 409: {
        if (!face) return head
        // Nothing compiled at all wants a first source, not a recompile.
        return `${head}\n${compileHint(face, !/nothing compiled/i.test(err.message), 'decide')}`
      }

      case 503: {
        // With a wait named, the retry gave up on it or was told not to wait
        // it out. Without one, the decision model failed; that may pass.
        if (err.retryAfter !== undefined) return `${head}\nTry again in ${err.retryAfter}s.`
        const others = (this.models ?? [...DECISION_MODELS]).filter((m) => m !== model).join(', ')
        return `${head}\nTry again. If the message names the decision model, another --model may answer (${others}).`
      }

      case 504: {
        return `${head}\n${face ? 'The face' : 'The decision'} did not finish within 300 seconds. Ask again.`
      }

      default: {
        return head
      }
    }
  }
}
