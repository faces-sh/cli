import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from '../../base.js'
import {chatgptLinked} from '../../style.js'
import {FacesAPIError} from '../../client.js'
import {postChat, writeReply, streamChat, resolveCause, CAUSE_FLAG_DESCRIPTION, CAUSE_FILE_FLAG_DESCRIPTION, retryOnceOnWarmUp, sayWarmUp, faceRefusalHint, STREAM_FLAG_DESCRIPTION, extractReasoning, extractStreamDelta, extractStreamReasoning, reasoningHeading, reasoningOnlyNote, REASONING_FLAG_DESCRIPTION, isMaxTokensRenameError, MIN_MAX_OUTPUT_TOKENS, STYLE_FLAG_DESCRIPTION, MEDIUM_FLAG_DESCRIPTION, SESSION_FLAG_DESCRIPTION, COMPACTION_FLAG_DESCRIPTION, chatExtras, warnDroppedParams, CHAT_PARAM_FLAGS, parseTemperature} from '../../utils.js'
import {conversationFields, conversationTurnFlags} from '../../conversation.js'
import {resolveEndpoint, RouteInfo, MESSAGES_ENDPOINT, RESPONSES_ENDPOINT, isCompositeFormula, faceSpecOf, llmFromArg} from '../../routing.js'

export default class ChatChat extends BaseCommand {
  static description =
    'Chat with a face on any supported model. The face\'s cause steers the model\'s answer. Routes to the ' +
    'right endpoint from the model catalog. A face named without a model answers on its default model. ' +
    '--show-cause also prints the cause, and --cause-only asks for the cause alone, with no answer. ' +
    'Add --style <medium> to apply a style the face has built, --conversation to take the turn in a ' +
    'conversation (see faces conversation:create), and --compaction to read a compaction.'

  static examples = [
    '<%= config.bin %> <%= command.id %> socrates -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> alice -m "Reply to the note below." --style email',
    '<%= config.bin %> <%= command.id %> socrates -m "Should I sign a grant I have not read?" --show-cause',
    '<%= config.bin %> <%= command.id %> socrates -m "Should I sign a grant I have not read?" --cause-only',
    '<%= config.bin %> <%= command.id %> socrates -m "Can you just sign it?" --cause "I will not sign what I have not read."',
    '<%= config.bin %> <%= command.id %> alice -m "So what do I tell them tomorrow?" --conversation fs_CONVERSATION_ID',
    '<%= config.bin %> <%= command.id %> alice -m "Is this vendor worth a closer look?" --conversation fs_CONVERSATION_ID ' +
      '--premise budget_usd=50000 --premise-description budget_usd="the most we can spend this year"',
    '<%= config.bin %> <%= command.id %> "(socrates | nietzsche)@claude-sonnet-4-6" -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> --formula "socrates | nietzsche" --llm claude-sonnet-4-6 -m "What is virtue?"',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    message: Flags.string({char: 'm', description: 'User message (repeatable)', multiple: true, required: false}),
    llm: Flags.string({description: 'LLM override (e.g. gpt-4o-mini, claude-sonnet-4-6)'}),
    formula: Flags.string({description: 'Compose a run-time composite from your own faces, e.g. "socrates | nietzsche" (operators: | & ^ -). Requires --llm, except with --cause-only. The composite takes the name of its first operand; use face:create --formula for a named, persisted composite.'}),
    system: Flags.string({description: 'System prompt / instructions'}),
    stream: Flags.boolean({description: STREAM_FLAG_DESCRIPTION, default: true, allowNo: true}),
    'max-tokens': Flags.integer({description: 'Max tokens (at least 1)', min: 1}),
    temperature: Flags.string({description: 'Temperature (0.0-2.0)'}),
    file: Flags.string({description: 'Read message from file'}),
    responses: Flags.boolean({description: 'Force the OpenAI Responses API endpoint (escape hatch; routing is automatic otherwise)', default: false}),
    style: Flags.string({description: STYLE_FLAG_DESCRIPTION}),
    medium: Flags.string({description: MEDIUM_FLAG_DESCRIPTION}),
    ...conversationTurnFlags(),
    session: Flags.string({description: SESSION_FLAG_DESCRIPTION}),
    compaction: Flags.string({description: COMPACTION_FLAG_DESCRIPTION}),
    'oauth-only': Flags.boolean({description: 'On a linked ChatGPT plan, run there or fail: never fall back to credits', default: false}),
    'show-cause': Flags.boolean({description: REASONING_FLAG_DESCRIPTION, default: false}),
    cause: Flags.string({description: CAUSE_FLAG_DESCRIPTION}),
    'cause-file': Flags.string({description: CAUSE_FILE_FLAG_DESCRIPTION, exclusive: ['cause']}),
    'cause-only': Flags.boolean({
      description:
        'Ask for the face\'s cause alone, with no answer: no model is called, and only the cause is ' +
        'charged. Printed to stdout.',
      default: false,
      exclusive: ['llm', 'style', 'medium', 'show-cause', 'cause', 'cause-file'],
    }),
  }

  static args = {
    face_username: Args.string({
      description:
        'Face alias (alias@model, owner:alias@model for a published face, or a composite formula like ' +
        '"(a | b)@model"). Omit when using --formula.',
      required: false,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ChatChat)
    const client = this.makeClient(flags)

    // Build model string
    let model: string
    if (flags.formula) {
      if (args.face_username) this.error('Pass either a face argument or --formula, not both.')
      if (!flags.llm && !flags['cause-only']) this.error('--formula needs a model. Add --llm <model>, e.g. --llm claude-sonnet-4-6.')
      model = flags.llm ? `(${flags.formula.trim()})@${flags.llm}` : `(${flags.formula.trim()})`
    } else if (!args.face_username) {
      this.error('Provide a face (alias, owner:alias, or a composite formula), or use --formula.')
    } else if (flags.llm) {
      const base = faceSpecOf(args.face_username)
      model = `${base}@${flags.llm}`
    } else {
      model = args.face_username
    }

    // A run-time composite has no stored default_model, so a reply needs an
    // explicit @model. Its cause alone needs none.
    if (isCompositeFormula(model) && !llmFromArg(model) && !flags['cause-only']) {
      const spec = faceSpecOf(model)
      this.error(
        `Composite face '${spec}' has no default model. Specify one explicitly, ` +
          `e.g. '${spec}@claude-sonnet-4-6', or pass --llm <model>.`,
      )
    }

    if (flags.style && isCompositeFormula(model)) {
      this.error('--style applies to one face, not a combination of faces.')
    }

    // Collect user messages
    const userMessages: string[] = []
    if (flags.file) {
      if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
      userMessages.push(fs.readFileSync(flags.file, 'utf8'))
    } else if (flags.message && flags.message.length > 0) {
      userMessages.push(...flags.message)
    } else {
      this.error('Provide at least one --message/-m or --file')
    }

    if (flags['cause-only'] && llmFromArg(model)) {
      this.error(`--cause-only asks the face alone, so leave the model off: ${faceSpecOf(model)}`)
    }

    // Checked before routing, which asks the server.
    let turn: Record<string, unknown>
    try {
      turn = conversationFields(flags)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    this.conversationBody = turn

    // Route off the model catalog; --responses forces the Responses endpoint.
    const route = await resolveEndpoint(client, model)
    const endpoint = flags.responses ? RESPONSES_ENDPOINT : route.endpoint

    // A face named alone gives only its cause now; the server no longer
    // answers it on the face's default model. Asking for a reply means naming
    // that model, which routing has just looked up. Without one, sending the
    // bare alias would bill for a cause nobody asked for, so say so instead.
    if (!flags['cause-only'] && !llmFromArg(model)) {
      if (!route.llm) {
        this.error(
          `${model} has no default model to answer on, so name one: ${model}@<model>, or add --llm <model>.\n` +
            'For the face\'s cause alone, with no answer, add --cause-only.',
        )
      }
      model = `${model}@${route.llm}`
    }

    // Streamed by default: a streamed request waits for the face's cause
    // however long it takes, where one that is not has 35s. Not for --json,
    // which wants the whole body and its cost headers.
    let cause: string | undefined
    try {
      cause = resolveCause(flags.cause, flags['cause-file'])
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    const send = {...flags, cause, stream: flags.stream && !this.jsonEnabled()}

    this.reasoningOnly = flags['cause-only']
    try {
      if (endpoint === MESSAGES_ENDPOINT) {
        return await this.runMessages(client, model, userMessages, send)
      } else if (endpoint === RESPONSES_ENDPOINT) {
        return await this.runResponses(client, model, userMessages, send)
      } else {
        return await this.runChatCompletions(client, model, userMessages, send)
      }
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.errorCode === 'oauth_rejected') this.error(`OAuth failed: ${err.message}\n${await this.oauthHint(err, {...route, endpoint}, client)}`)
        // The catalog's codex_eligible says a model CAN run on ChatGPT, not that
        // this user's ChatGPT plan serves it.
        if (err.errorCode === 'model_not_supported') {
          this.error(
            `${err.message}\n` +
              'Your ChatGPT plan does not serve this model. Pick another with --llm, ' +
              'or let it run on credits: faces account:preferences api_fallback true',
          )
        }
        const hint = faceRefusalHint(err, model, flags.style)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }
  }

  private async oauthHint(err: FacesAPIError, route: RouteInfo, client: ReturnType<typeof this.makeClient>): Promise<string> {
    const hints: string[] = []
    const linked = await chatgptLinked(client)
    if (linked === false) hints.push('No ChatGPT account is linked. Link one with: faces auth:connect openai')
    else hints.push('If the ChatGPT link has lapsed, link it again with: faces auth:connect openai')
    if (route.endpoint === RESPONSES_ENDPOINT && route.freeWhenConnected && linked === false) {
      hints.push('This model is free once it is linked.')
    }

    if (err.fallbackAvailable) {
      hints.push('Or allow paid fallback: faces account:preferences api_fallback true')
    } else {
      // Suggesting a top-up to an account with credit sent people to pay for
      // nothing; ask only when the balance is actually empty.
      let balance: number | undefined
      try {
        balance = Number(((await client.get('/v1/billing/balance')) as Record<string, unknown>).balance_usd)
      } catch { /* unknown */ }
      hints.push(
        balance !== undefined && balance > 0
          ? 'Or allow paid fallback on your credits: faces account:preferences api_fallback true'
          : 'Or add credits (faces billing:topup --amount <usd>) and allow paid fallback: faces account:preferences api_fallback true',
      )
    }

    return hints.join('\n')
  }

  private metaFor(headers: Record<string, string>, endpoint: string, model: string): Record<string, string> {
    const meta: Record<string, string> = {}
    if (headers['x-faces-provider']) meta.provider = headers['x-faces-provider']
    if (headers['x-faces-cost-usd']) meta.cost_usd = headers['x-faces-cost-usd']
    // oauth (the linked ChatGPT subscription paid, so it cost nothing) or
    // credits. provider names the model's lab now, so it no longer says this.
    if (headers['x-faces-billing']) meta.billing = headers['x-faces-billing']
    meta.endpoint = endpoint
    // What was sent, which is not always what was typed: a bare alias goes
    // with its default model added.
    meta.model = model
    return meta
  }

  /**
   * Stream the reply to stdout. The face's cause streams first: to stderr
   * under --show-cause, and otherwise held back, to stand in for the reply if
   * none comes (a bare alias, or --cause-only).
   */
  private async streamDeltas(
    client: ReturnType<typeof this.makeClient>,
    endpoint: string,
    payload: Record<string, unknown>,
    showReasoning: boolean,
  ): Promise<void> {
    const model = String(payload.model)
    let reasoning = ''
    let replied = false
    const onHeaders = (headers: Record<string, string>) => warnDroppedParams(headers, CHAT_PARAM_FLAGS)
    for await (const line of streamChat(client, endpoint, payload, onHeaders)) {
      if (!line.startsWith('data: ')) continue
      const chunk = line.slice(6)
      if (chunk.trim() === '[DONE]' || chunk.trim() === '') continue
      try {
        const parsed = JSON.parse(chunk) as Record<string, unknown>
        const thought = extractStreamReasoning(parsed)
        if (thought) {
          if (showReasoning && !reasoning) process.stderr.write(`${reasoningHeading(model)}\n`)
          if (showReasoning) process.stderr.write(thought)
          reasoning += thought
        }
        const delta = extractStreamDelta(parsed)
        if (delta) {
          if (showReasoning && reasoning && !replied) process.stderr.write('\n\n')
          replied = true
          process.stdout.write(delta)
        }
      } catch { /* ignore parse errors */ }
    }
    if (!replied && reasoning) {
      if (showReasoning) process.stderr.write('\n')
      else process.stdout.write(`${reasoning}\n`)
      this.noteReasoningOnly(model)
    } else if (!replied) {
      // Nothing at all is a failure, whatever the status said.
      this.error('The reply stream ended with no answer and no cause. Run it again with --no-stream to see what the server said.')
    } else {
      process.stdout.write('\n')
    }
  }

  private printReply(model: string, reasoning: string, text: string, showReasoning: boolean): void {
    writeReply(model, reasoning, text, showReasoning, this.reasoningOnly ? undefined : reasoningOnlyNote(model))
  }

  /** Explain a cause-only reply, unless the cause alone was what was asked for. */
  private noteReasoningOnly(model: string): void {
    if (this.reasoningOnly) return
    process.stderr.write(`\n${reasoningOnlyNote(model)}\n`)
  }

  private reasoningOnly = false

  /** --conversation, --premise and --causes-visible, as request fields. */
  private conversationBody: Record<string, unknown> = {}

  private async runChatCompletions(
    client: ReturnType<typeof this.makeClient>,
    model: string,
    userMessages: string[],
    flags: {system?: string; stream: boolean; 'max-tokens'?: number; temperature?: string; style?: string; medium?: string; session?: string; compaction?: string; 'oauth-only': boolean; 'show-cause': boolean; cause?: string},
  ): Promise<unknown> {
    const messages: Array<{role: string; content: string}> = []
    if (flags.system) messages.push({role: 'system', content: flags.system})
    for (const m of userMessages) messages.push({role: 'user', content: m})

    const payload: Record<string, unknown> = {model, messages, stream: flags.stream}
    if (flags['max-tokens']) payload.max_tokens = flags['max-tokens']
    if (flags.temperature !== undefined) payload.temperature = parseTemperature(flags.temperature, (m) => this.error(m))
    Object.assign(payload, chatExtras(flags), this.conversationBody)
    if (flags['oauth-only']) payload.oauth_only = true
    if (flags.cause) payload.cause = flags.cause

    if (flags.stream) {
      await this.streamDeltas(client, '/v1/chat/completions', payload, flags['show-cause'])
      return {}
    }

    let data: unknown
    let headers: Record<string, string>
    try {
      ;({data, headers} = await retryOnceOnWarmUp(() => postChat(client, '/v1/chat/completions', payload), sayWarmUp))
    } catch (err) {
      if (err instanceof FacesAPIError && isMaxTokensRenameError(err.message) && payload.max_tokens !== undefined) {
        payload.max_completion_tokens = payload.max_tokens
        delete payload.max_tokens
        ;({data, headers} = await retryOnceOnWarmUp(() => postChat(client, '/v1/chat/completions', payload), sayWarmUp))
      } else {
        throw err
      }
    }
    if (!this.jsonEnabled()) warnDroppedParams(headers, CHAT_PARAM_FLAGS)
    const body = data as Record<string, unknown>
    const choices = body.choices as Array<Record<string, unknown>> | undefined
    const text = String((choices?.[0]?.message as Record<string, unknown> | undefined)?.content ?? '')

    if (this.jsonEnabled()) {
      body._meta = this.metaFor(headers, '/v1/chat/completions', model)
      return body
    }
    this.printReply(model, extractReasoning(body, '/v1/chat/completions'), text, flags['show-cause'])
    return body
  }

  private async runMessages(
    client: ReturnType<typeof this.makeClient>,
    model: string,
    userMessages: string[],
    flags: {system?: string; stream: boolean; 'max-tokens'?: number; style?: string; medium?: string; session?: string; compaction?: string; 'oauth-only': boolean; 'show-cause': boolean; cause?: string},
  ): Promise<unknown> {
    const msgs = userMessages.map((m) => ({role: 'user', content: m}))
    const payload: Record<string, unknown> = {
      model,
      messages: msgs,
      max_tokens: flags['max-tokens'] ?? 1024,
      stream: flags.stream,
    }
    if (flags.system) payload.system = flags.system
    Object.assign(payload, chatExtras(flags), this.conversationBody)
    if (flags['oauth-only']) payload.oauth_only = true
    if (flags.cause) payload.cause = flags.cause

    if (flags.stream) {
      await this.streamDeltas(client, '/v1/messages', payload, flags['show-cause'])
      return {}
    }

    const {data, headers} = await retryOnceOnWarmUp(() => postChat(client, '/v1/messages', payload), sayWarmUp)
    if (!this.jsonEnabled()) warnDroppedParams(headers, CHAT_PARAM_FLAGS)
    const body = data as Record<string, unknown>
    if (this.jsonEnabled()) {
      body._meta = this.metaFor(headers, '/v1/messages', model)
      return body
    }

    let content = ''
    for (const block of (body.content as Array<Record<string, unknown>>) ?? []) {
      if (block.type === 'text') content += String(block.text ?? '')
    }
    this.printReply(model, extractReasoning(body, '/v1/messages'), content, flags['show-cause'])
    return body
  }

  private async runResponses(
    client: ReturnType<typeof this.makeClient>,
    model: string,
    userMessages: string[],
    flags: {system?: string; stream: boolean; 'max-tokens'?: number; temperature?: string; style?: string; medium?: string; session?: string; compaction?: string; 'oauth-only': boolean; 'show-cause': boolean; cause?: string},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      model,
      input: userMessages.map((m) => ({role: 'user', content: m})),
      stream: flags.stream,
    }
    if (flags.system) payload.instructions = flags.system
    // Responses names the output cap `max_output_tokens`, not `max_tokens`.
    // `temperature` is accepted per-model (gpt-5.1/5.2/5.4 yes; gpt-5.5/5.6-*/o3
    // no) with no capability flag to query, so we always send what the user asked
    // for: the backend strips the param and retries when a model 400s on it.
    // 0 is falsy, so it skipped the check and went out as no cap at all.
    if (flags['max-tokens'] !== undefined) {
      if (flags['max-tokens'] < MIN_MAX_OUTPUT_TOKENS) {
        this.error(
          `--max-tokens must be at least ${MIN_MAX_OUTPUT_TOKENS} for this model (got ${flags['max-tokens']}). ` +
            'The Responses API rejects a smaller output cap.',
        )
      }
      payload.max_output_tokens = flags['max-tokens']
    }
    if (flags.temperature !== undefined) payload.temperature = parseTemperature(flags.temperature, (m) => this.error(m))
    Object.assign(payload, chatExtras(flags), this.conversationBody)
    if (flags['oauth-only']) payload.oauth_only = true
    if (flags.cause) payload.cause = flags.cause

    if (flags.stream) {
      await this.streamDeltas(client, '/v1/responses', payload, flags['show-cause'])
      return {}
    }

    const {data, headers} = await retryOnceOnWarmUp(() => postChat(client, '/v1/responses', payload), sayWarmUp)
    if (!this.jsonEnabled()) warnDroppedParams(headers, CHAT_PARAM_FLAGS)
    const body = data as Record<string, unknown>
    if (this.jsonEnabled()) {
      body._meta = this.metaFor(headers, '/v1/responses', model)
      return body
    }

    let outputText = ''
    for (const item of (body.output as Array<Record<string, unknown>>) ?? []) {
      for (const block of (item.content as Array<Record<string, unknown>>) ?? []) {
        if (block.type === 'output_text') outputText += String(block.text ?? '')
      }
    }
    this.printReply(model, extractReasoning(body, '/v1/responses'), outputText, flags['show-cause'])
    return body
  }
}
