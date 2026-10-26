import fs from 'node:fs'
import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base.js'
import {FacesAPIError} from '../client.js'
import {QUESTION_TYPES, causeLines, heldDecisionError, readQuestionFlags, readStateFlags, type DecisionCauses} from '../decisions.js'
import {compileHint, isMeAlias, ME_MISSING, retryOnceOnWarmUp, sayWarmUp, SESSION_FLAG_DESCRIPTION, COMPACTION_FLAG_DESCRIPTION} from '../utils.js'

/** The most questions one request to /v1/causes takes. */
const MAX_CAUSE_QUESTIONS = 10

export default class Causes extends BaseCommand {
  static description =
    'Get a face\'s cause alone, with no answering model: the principal why behind its response in this ' +
    'context (POST /v1/causes). Send a conversation with -m, or a situation with --state, optionally with ' +
    'questions for one cause per question. Billed at the cause rate only (see faces models:list --kind cause). ' +
    'A cause takes about 10 seconds. To have a model answer, use chat:chat or decide.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice -m "Should I take the offer?"',
    '<%= config.bin %> <%= command.id %> alice --state "A fund offers $80k to change a finding before it is published."',
    '<%= config.bin %> <%= command.id %> alice --state-file situation.txt --question "Does the speaker take the money?"',
    '<%= config.bin %> <%= command.id %> "(alice | bob)" -m "What matters most here?" --json',
    '<%= config.bin %> <%= command.id %> alice -m "So what do I tell them tomorrow?" --compaction fcmp_COMPACTION_ID',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    message: Flags.string({
      char: 'm',
      description: 'A user message (repeatable, sent in order). The cause is for the last one.',
      multiple: true,
      exclusive: ['state', 'state-file', 'file'],
    }),
    file: Flags.string({description: 'Read the user message from a file.', exclusive: ['message', 'state', 'state-file']}),
    state: Flags.string({
      description: 'A situation, as plain text, in place of a conversation.',
      exclusive: ['state-file', 'message', 'file'],
    }),
    'state-file': Flags.string({
      description: 'Read the situation from this file. A .json file is sent as the JSON it holds.',
      exclusive: ['state', 'message', 'file'],
    }),
    question: Flags.string({
      description:
        'A question about the situation, for a cause of its own. Its type follows from --option (a choice), ' +
        '--level (a score), or neither (a yes-or-no). Needs --state or --state-file.',
      exclusive: ['questions-file'],
    }),
    type: Flags.string({description: 'The type of --question.', options: [...QUESTION_TYPES], dependsOn: ['question']}),
    option: Flags.string({description: 'An option for a choice, as name="description" (repeatable).', multiple: true, dependsOn: ['question'], exclusive: ['level']}),
    level: Flags.string({description: 'A level of a score, lowest first (repeatable).', multiple: true, dependsOn: ['question'], exclusive: ['option']}),
    id: Flags.string({description: 'Key for the --question in the result (default: answer)', dependsOn: ['question']}),
    'questions-file': Flags.string({
      description: `A JSON file of 1 to ${MAX_CAUSE_QUESTIONS} questions in System One's format, as for faces decide. Needs --state or --state-file.`,
      exclusive: ['question'],
    }),
    session: Flags.string({description: SESSION_FLAG_DESCRIPTION}),
    compaction: Flags.string({description: COMPACTION_FLAG_DESCRIPTION}),
  }

  static args = {
    face: Args.string({
      description: 'The face: an alias, owner:alias for a face shared with you, or a composite such as "(a | b)". No @model.',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Causes)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()
    const face = args.face.trim()

    if (face.includes('@')) {
      this.error(`A cause is the face's alone, so leave the model off: ${face.slice(0, face.lastIndexOf('@'))}\nTo have a model answer, use faces chat:chat.`)
    }

    const fail = (m: string): never => this.error(m)
    const body: Record<string, unknown> = {model: face}
    const situation = flags.state !== undefined || flags['state-file'] !== undefined
    const questions = readQuestionFlags(flags, fail)

    if (situation) {
      body.state = readStateFlags(flags, fail)
      if (questions) {
        const n = Object.keys(questions).length
        if (n > MAX_CAUSE_QUESTIONS) this.error(`At most ${MAX_CAUSE_QUESTIONS} questions (got ${n}). Split them across requests.`)
        body.questions = questions
      }
    } else {
      if (questions) this.error('Questions go with a situation: add --state or --state-file.')
      const messages: string[] = []
      if (flags.file) {
        if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
        messages.push(fs.readFileSync(flags.file, 'utf8'))
      } else if (flags.message?.length) {
        messages.push(...flags.message)
      } else {
        this.error('Send a conversation with -m (or --file), or a situation with --state (or --state-file).')
      }
      body.messages = messages.map((content) => ({role: 'user', content}))
    }

    if (flags.session) body.session = flags.session
    if (flags.compaction) body.compaction = flags.compaction

    let data: DecisionCauses & Record<string, unknown>
    try {
      data = (await retryOnceOnWarmUp(async () => {
        const res = await client.post('/v1/causes', {body})
        const held = heldDecisionError(res)
        if (held) throw held
        return res
      }, json ? undefined : sayWarmUp)) as typeof data
    } catch (err) {
      if (err instanceof FacesAPIError) {
        const head = `HTTP ${err.statusCode}: ${err.message}`
        if (err.statusCode === 409) this.error(`${head}\n${compileHint(face, !/nothing compiled/i.test(err.message), 'give a cause')}`)
        if (err.statusCode === 404 && isMeAlias(face)) this.error(`${head}\n${ME_MISSING}`)
        if (err.statusCode === 503) this.error(`${head}\n${err.retryAfter === undefined ? 'Try again.' : `Try again in ${err.retryAfter}s.`}`)
        if (err.statusCode === 504) this.error(`${head}\nThe face did not finish within 300 seconds. Ask again.`)
        this.error(head)
      }
      throw err
    }

    if (json) return data
    const lines = causeLines(data, questions ? Object.keys(questions) : [])
    if (lines.length === 0) this.error('The response carried no cause. Run it again with --json to see what the server said.')
    for (const line of lines) this.log(line)
    return data
  }
}
