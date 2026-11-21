import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base.js'
import {FacesAPIError, missingFieldsNote} from '../client.js'
import {conversationFields, conversationTurnFlags, MAX_DEPENDS_ON, parseDependsOn} from '../conversation.js'
import {
  DECISION_MODELS,
  decisionModels,
  DECISION_FORMATS,
  fromOpenAIAnswers,
  toOpenAIDecision,
  questionsProblem,
  MAX_WARM_UP_WAIT_S,
  QUESTION_TYPES,
  decisionLines,
  heldDecisionError,
  readStateFlags,
  readQuestionFlags,
  warmUpWait,
} from '../decisions.js'
import {compileHint, sayWarmUp, SESSION_FLAG_DESCRIPTION, COMPACTION_FLAG_DESCRIPTION} from '../utils.js'
import {modelProblem, parseModel} from '../model.js'

/** Decision models served on /v1/decisions in OpenAI's format and refused on /v1/systemone. */
const OPENAI_FORMAT_ONLY = ['gpt-6-luna'] as const

export default class Decide extends BaseCommand {
  static description =
    'Ask what a face would decide. Describe a situation, ask typed questions about it, and get back numbers, ' +
    'as this face: a yes-or-no (noul), a pick between options (choice), or a place on a graded scale (score). ' +
    'faces choices gives you the options a face would weigh; this gives you what it would decide, for routing, ' +
    'simulations or panels. Name the model as the upstream model over the decision model: ' +
    '@alice:maestro-1/jev-latest. The face steers the decision model\'s answer. An answer takes about 10 to 20 ' +
    'seconds; one that runs long is held open by the server and can take a minute or more. ' +
    'The steering is billed per input token plus a small fee per call (see faces models:list --kind upstream), ' +
    'and the decision model at its listed price. A face needs something compiled.'

  static examples = [
    '<%= config.bin %> <%= command.id %> @alice:maestro-1/jev-latest --state "A colleague asks you to sign a grant proposal you have not read, due in an hour." ' +
      '--question "Does the speaker sign?" --option yes="signs it as asked" --option no="declines to sign" ' +
      '--option later="asks for time to read it first"',
    '<%= config.bin %> <%= command.id %> @alice:maestro-1/jev-latest --state-file situation.txt --question "Is the speaker irritated?"',
    '<%= config.bin %> <%= command.id %> @alice:maestro-1-flash/clef --state-file situation.txt --question "How firm is the reply?" ' +
      '--level yields --level hedges --level firm',
    '<%= config.bin %> <%= command.id %> "(@alice | @bob):maestro-1/jev-latest" --state-file situation.json --questions-file questions.json --json',
    '<%= config.bin %> <%= command.id %> @alice:maestro-1/gpt-6-luna --state-file situation.txt --questions-file questions.json',
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
    ...conversationTurnFlags(),
    'depends-on': Flags.string({
      description:
        'In a state (--conversation), what this decision rests on, comma separated: premise keys, decision ids and ' +
        'option ids (opt_..., or cho_... for all of a choices list, from faces choices --state-id) ' +
        `already in the state or set with --premise, at most ${MAX_DEPENDS_ON} (a key that holds a comma goes in ` +
        'double quotes: \'"x, y",dec_1\'). The decision is shown those, and is ' +
        'invalidated when one of them is. Left out, it rests on every premise in force.',
    }),
    session: Flags.string({description: SESSION_FLAG_DESCRIPTION}),
    compaction: Flags.string({description: COMPACTION_FLAG_DESCRIPTION}),
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
    model: Args.string({
      description:
        'The upstream model over the decision model: @<face>:<maestro>/<decision model>, e.g. ' +
        '@alice:maestro-1/jev-latest. Another account\'s face is @owner~face; a composite is ' +
        '"(@a | @b):maestro-1/jev-latest". The decision models are jev-latest, clef, clef-flash and gpt-6-luna ' +
        'today (faces models:list --kind decision); gpt-6-luna answers in OpenAI\'s format only, so it uses --format openai.',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Decide)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    const problem = modelProblem(args.model, 'both', 'jev-latest')
    if (problem) this.error(problem)
    const name = parseModel(args.model)
    const face = name.faces as string
    let downstream = name.downstream as string

    let turn: Record<string, unknown> = {}
    try {
      turn = conversationFields(flags)
      if (flags['depends-on'] !== undefined) {
        if (!flags.conversation && !flags.session) throw new Error('--depends-on belongs to a state: add --conversation <id> (from faces state:create).')
        turn.depends_on = parseDependsOn(flags['depends-on'])
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    const state = this.readState(flags)
    const questions = this.readQuestions(flags)
    if (!questions) this.error('Ask at least one question, with --question or --questions-file.')
    const openaiOnly = (OPENAI_FORMAT_ONLY as readonly string[]).includes(downstream.toLowerCase())
    const problemQ = questionsProblem(questions, true, openaiOnly)
    if (problemQ) this.error(problemQ)
    this.models = await decisionModels(client)
    // The server matches the id exactly, so send the catalog's spelling.
    const match = this.models.find((m) => m.toLowerCase() === downstream.toLowerCase())
    if (!match) this.error(`'${downstream}' is not a decision model. The decision models are: ${this.models.join(', ')}.`)
    downstream = match
    // OpenAI's Decisions model is served only in OpenAI's format.
    if ((OPENAI_FORMAT_ONLY as readonly string[]).includes(match)) {
      if (this.argv.some((a) => a === '--format=systemone' || a === 'systemone')) {
        this.error(`${match} answers in OpenAI's format only. Use --format openai, or leave --format out.`)
      }
      flags.format = 'openai'
    }

    const model = `${name.upstream}/${downstream}`
    let body: Record<string, unknown> = {model, state, questions}
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
      process.stderr.write(`Asking ${face}. Decision model: ${downstream}. This usually takes 10 to 20 seconds, sometimes a minute or more.\n`)
    }

    let data: {answers?: Record<string, unknown>; decision_ids?: Record<string, string>}
    try {
      data = (await this.ask(client, body, flags.retry, json, flags.format === 'openai' ? '/v1/decisions' : '/v1/systemone')) as typeof data
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(this.explain(err, face, downstream))
      throw err
    }

    // Say plainly when a field this relies on is missing, rather than printing
    // an empty line: the API renames fields as it goes, and the fix is usually
    // an update.
    const missing = missingFieldsNote(data, ['answers'])
    if (missing) process.stderr.write(`${missing}\n`)

    if (json) return data
    const answers = flags.format === 'openai' ? fromOpenAIAnswers(data.answers, questions) : (data.answers ?? {})
    for (const line of decisionLines(answers)) this.log(line)
    const ids = Object.entries(data.decision_ids ?? {})
    if (ids.length > 0) {
      this.log('')
      for (const [q, id] of ids) this.log(`decision id (${q}): ${id}`)
    }
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
  private explain(err: FacesAPIError, face: string, model: string): string {
    const head = `HTTP ${err.statusCode}: ${err.message}`
    switch (err.statusCode) {
      case 409: {
        // Nothing compiled at all wants a first source, not a recompile.
        return `${head}\n${compileHint(face.replace(/^@/, '').replace('~', ':'), !/nothing compiled/i.test(err.message), 'decide')}`
      }

      case 503: {
        // With a wait named, the retry gave up on it or was told not to wait
        // it out. Without one, the decision model failed; that may pass.
        if (err.retryAfter !== undefined) return `${head}\nTry again in ${err.retryAfter}s.`
        const others = (this.models ?? [...DECISION_MODELS]).filter((m) => m !== model).join(', ')
        return `${head}\nTry again. If the message names the decision model, another decision model may answer (${others}).`
      }

      case 504: {
        return `${head}\nThe face did not finish within 300 seconds. Ask again.`
      }

      default: {
        return head
      }
    }
  }
}
