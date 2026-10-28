import {Args, Flags} from '@oclif/core'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {BaseCommand} from '../../base.js'
import {conversationFields, conversationTurnFlags} from '../../conversation.js'
import {FacesAPIError, FacesClient} from '../../client.js'
import {postChat, streamChat, resolveCause, CAUSE_FLAG_DESCRIPTION, CAUSE_FILE_FLAG_DESCRIPTION, retryOnceOnWarmUp, sayWarmUp, faceRefusalHint, STREAM_FLAG_DESCRIPTION, extractCause, extractStreamDelta, FACES_REASONING_ITEM_PREFIX, FACES_THINKING_SIGNATURE, extractStreamReasoning, isMaxTokensRenameError, MIN_MAX_OUTPUT_TOKENS, STYLE_FLAG_DESCRIPTION, MEDIUM_FLAG_DESCRIPTION, SESSION_FLAG_DESCRIPTION, COMPACTION_FLAG_DESCRIPTION, chatExtras, reasoningHeading, REASONING_FLAG_DESCRIPTION, parseTemperature} from '../../utils.js'
import {resolveEndpoint, isCompositeFormula, llmFromArg, MESSAGES_ENDPOINT, RESPONSES_ENDPOINT, CHAT_COMPLETIONS_ENDPOINT} from '../../routing.js'

const THREADS_DIR = path.join(os.homedir(), '.faces', 'threads')

type Role = 'user' | 'assistant'

interface ThreadMessage {
  role: Role
  content: string
  ts: string
  /**
   * On an assistant turn, the face's cause before it answered, kept so it
   * goes back with the turn: the face then builds on its earlier causes
   * rather than starting fresh. The server carries the last 10.
   */
  cause?: string
  /** The Responses item id the cause came in (`rs_faces_…`), sent back as it was. */
  cause_id?: string
  /** On Chat Completions, a reasoning model's own working, kept as returned. */
  reasoning_content?: string
}

interface Thread {
  id: string
  face_username: string  // alias only (no @model)
  model: string          // full alias@llm
  provider: 'anthropic' | 'openai'
  endpoint?: string      // resolved API endpoint (cached after first send)
  system?: string
  created_at: string
  updated_at: string
  messages: ThreadMessage[]
}

/**
 * Extract assistant text for a known endpoint. Routing is deterministic, so we
 * parse exactly one shape: Anthropic Messages, OpenAI Responses, or Chat
 * Completions.
 */
function extractAssistantText(body: Record<string, unknown>, endpoint: string): string {
  if (endpoint === MESSAGES_ENDPOINT) {
    let text = ''
    for (const block of (body.content as Array<Record<string, unknown>>) ?? []) {
      if (block.type === 'text') text += String(block.text ?? '')
    }
    return text
  }
  if (endpoint === RESPONSES_ENDPOINT) {
    let text = ''
    for (const item of (body.output as Array<Record<string, unknown>>) ?? []) {
      for (const block of (item.content as Array<Record<string, unknown>>) ?? []) {
        if (block.type === 'output_text') text += String(block.text ?? '')
      }
    }
    return text
  }
  // Chat Completions: { choices: [{message: {content}}] }
  const choices = body.choices as Array<Record<string, unknown>> | undefined
  return String((choices?.[0]?.message as Record<string, unknown> | undefined)?.content ?? '')
}

/** A reply, and the face's cause before it, which is kept on the turn. */
interface Reply {
  text: string
  reasoning: string
  causeId?: string
  modelReasoning?: string
}

function replyOf(body: Record<string, unknown>, endpoint: string): Reply {
  const cause = extractCause(body, endpoint)
  const message = (body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined
  const modelReasoning = endpoint === CHAT_COMPLETIONS_ENDPOINT && message?.reasoning_content ? String(message.reasoning_content) : undefined
  return {text: extractAssistantText(body, endpoint), reasoning: cause.text, causeId: cause.id, modelReasoning}
}

/**
 * The transcript as each endpoint returned it, so the face's cause goes
 * back where it came from: `cause` on a chat turn, the `rs_faces_` item before
 * a Responses message, the `faces-reasoning` thinking block on a Messages turn.
 */
function chatTurn(m: ThreadMessage): Record<string, unknown> {
  const turn: Record<string, unknown> = {role: m.role, content: m.content}
  if (m.role === 'assistant' && m.cause) turn.cause = m.cause
  if (m.role === 'assistant' && m.reasoning_content) turn.reasoning_content = m.reasoning_content
  return turn
}

function responsesTurns(m: ThreadMessage): Array<Record<string, unknown>> {
  const turn = {role: m.role, content: m.content}
  if (m.role !== 'assistant' || !m.cause || !m.cause_id) return [turn]
  return [{type: 'reasoning', id: m.cause_id, summary: [{type: 'summary_text', text: m.cause}]}, turn]
}

function messagesTurn(m: ThreadMessage): Record<string, unknown> {
  if (m.role !== 'assistant' || !m.cause) return {role: m.role, content: m.content}
  return {
    role: m.role,
    content: [
      {type: 'thinking', thinking: m.cause, signature: FACES_THINKING_SIGNATURE},
      {type: 'text', text: m.content},
    ],
  }
}

function newThreadId(): string {
  return 't_' + crypto.randomBytes(6).toString('hex')
}

function threadPath(id: string): string {
  // The id names a file, so it must not be able to name any other one:
  // `--id ../config --delete` removed the saved credentials.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`"${id}" is not a thread id. List them with: faces chat:thread --list`)
  return path.join(THREADS_DIR, `${id}.json`)
}

function ensureThreadsDir(): void {
  if (!fs.existsSync(THREADS_DIR)) fs.mkdirSync(THREADS_DIR, {recursive: true, mode: 0o700})
}

function loadThread(id: string): Thread | null {
  const p = threadPath(id)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Thread
}

function saveThread(t: Thread): void {
  ensureThreadsDir()
  t.updated_at = new Date().toISOString()
  fs.writeFileSync(threadPath(t.id), JSON.stringify(t, null, 2), {mode: 0o600})
}

function listThreads(): Thread[] {
  if (!fs.existsSync(THREADS_DIR)) return []
  const out: Thread[] = []
  for (const f of fs.readdirSync(THREADS_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(THREADS_DIR, f), 'utf8')) as Thread)
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  return out
}

export default class ChatThread extends BaseCommand {
  static description =
    'Multi-turn chat thread. Conversation history is stored under ~/.faces/threads/<id>.json. Resume any thread later with --id. ' +
    'A face named without a model answers on its default model, which is fixed on the thread when it starts. ' +
    'Each turn keeps the face\'s cause and sends it back with the transcript.'

  static examples = [
    '<%= config.bin %> <%= command.id %> socrates -m "What is justice?"',
    '<%= config.bin %> <%= command.id %> --id t_abc123 -m "Say more about that"',
    '<%= config.bin %> <%= command.id %> --list',
    '<%= config.bin %> <%= command.id %> --id t_abc123 --show',
    '<%= config.bin %> <%= command.id %> --id t_abc123 --delete',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({description: 'Resume an existing thread by id'}),
    message: Flags.string({char: 'm', description: 'User message'}),
    file: Flags.string({description: 'Read message from file'}),
    llm: Flags.string({description: 'LLM override (only honored when starting a new thread)'}),
    system: Flags.string({description: 'System prompt (only honored when starting a new thread)'}),
    'max-tokens': Flags.integer({description: 'Max tokens (at least 1)', min: 1}),
    temperature: Flags.string({description: 'Temperature (0.0-2.0)'}),
    stream: Flags.boolean({description: STREAM_FLAG_DESCRIPTION, default: true, allowNo: true}),
    style: Flags.string({description: `${STYLE_FLAG_DESCRIPTION} For this turn only.`}),
    medium: Flags.string({description: `${MEDIUM_FLAG_DESCRIPTION} For this turn only.`}),
    ...conversationTurnFlags({suffix: 'For this turn only. Only the new message is sent: the conversation holds the rest.'}),
    session: Flags.string({description: `${SESSION_FLAG_DESCRIPTION} For this turn only.`}),
    compaction: Flags.string({description: `${COMPACTION_FLAG_DESCRIPTION} For this turn only.`}),
    'oauth-only': Flags.boolean({description: 'On a linked ChatGPT plan, run there or fail: never fall back to credits', default: false}),
    'show-cause': Flags.boolean({description: REASONING_FLAG_DESCRIPTION, default: false}),
    cause: Flags.string({description: `${CAUSE_FLAG_DESCRIPTION} For this turn only; it is kept on the thread like any.`}),
    'cause-file': Flags.string({description: CAUSE_FILE_FLAG_DESCRIPTION, exclusive: ['cause']}),
    list: Flags.boolean({description: 'List saved threads', default: false}),
    show: Flags.boolean({description: 'Show the thread transcript (requires --id)', default: false}),
    delete: Flags.boolean({description: 'Delete the thread (requires --id)', default: false}),
    yes: Flags.boolean({description: 'Skip confirmation for --delete', default: false}),
  }

  static args = {
    face_username: Args.string({
      description: 'Face alias (alias@model, or owner:alias@model for a published face). Required when starting a new thread',
      required: false,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ChatThread)

    if (flags.list) return this.handleList()
    if (flags.delete) return this.handleDelete(flags.id, flags.yes)
    if (flags.show) return this.handleShow(flags.id)

    return this.handleMessage(args.face_username, flags)
  }

  private handleList(): unknown {
    const threads = listThreads()
    if (this.jsonEnabled()) {
      return threads.map((t) => ({
        id: t.id,
        face: t.face_username,
        model: t.model,
        turns: t.messages.length,
        created_at: t.created_at,
        updated_at: t.updated_at,
      }))
    }
    if (threads.length === 0) {
      this.log('(no threads)')
      return {}
    }
    for (const t of threads) {
      const last = t.messages[t.messages.length - 1]
      const preview = last
        ? last.content.slice(0, 60).replace(/\s+/g, ' ') + (last.content.length > 60 ? '…' : '')
        : ''
      this.log(`${t.id}  ${t.model}  (${t.messages.length} turns, updated ${t.updated_at})`)
      if (preview) this.log(`  ${last.role}: ${preview}`)
    }
    return {}
  }

  private async handleDelete(id: string | undefined, yes: boolean): Promise<unknown> {
    if (!id) this.error('--delete requires --id <thread-id>')
    const p = threadPath(id)
    if (!fs.existsSync(p)) this.error(`Thread not found: ${id}`)
    await this.confirmOrRefuse(`Delete thread ${id} and its history?`, yes)
    fs.unlinkSync(p)
    if (this.jsonEnabled()) return {deleted: id}
    this.log(`Deleted thread ${id}`)
    return {deleted: id}
  }

  private handleShow(id?: string): unknown {
    if (!id) this.error('--show requires --id <thread-id>')
    const t = loadThread(id)
    if (!t) this.error(`Thread not found: ${id}`)
    if (this.jsonEnabled()) return t
    this.log(`Thread ${t.id}  (${t.model}, provider=${t.provider})`)
    this.log(`Created: ${t.created_at}`)
    this.log(`Updated: ${t.updated_at}`)
    if (t.system) {
      this.log('---')
      this.log(`system: ${t.system}`)
    }
    for (const m of t.messages) {
      this.log('---')
      this.log(`${m.role} [${m.ts}]:`)
      this.log(m.content)
    }
    return t
  }

  private async handleMessage(
    face_username: string | undefined,
    flags: {
      id?: string
      message?: string
      file?: string
      llm?: string
      system?: string
      'max-tokens'?: number
      temperature?: string
      stream: boolean
      'oauth-only': boolean
      'show-cause': boolean
      style?: string
      medium?: string
      session?: string
      compaction?: string
      conversation?: string
      premise?: string[]
      'premise-description'?: string[]
      'causes-visible'?: boolean
      cause?: string
      'cause-file'?: string
      'base-url'?: string
      token?: string
      'api-key'?: string
    },
  ): Promise<unknown> {
    let userMessage: string
    if (flags.file) {
      if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
      userMessage = fs.readFileSync(flags.file, 'utf8')
    } else if (flags.message) {
      userMessage = flags.message
    } else {
      this.error('Provide --message/-m or --file')
    }

    try {
      this.conversationBody = conversationFields(flags)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    // In a conversation the server holds the history and reads it before the
    // new message, and keeps every user message it is sent: replaying the
    // thread would add its earlier messages to the conversation again.
    this.newOnly = Boolean(flags.conversation || flags.session)

    const client = this.makeClient(flags)

    let thread: Thread
    if (flags.id) {
      const existing = loadThread(flags.id)
      if (!existing) this.error(`Thread not found: ${flags.id}`)
      thread = existing
      if (flags.llm || flags.system) {
        this.warn('--llm and --system are ignored when resuming a thread; using values stored on the thread')
      }
    } else {
      if (!face_username) {
        this.error('Provide a face (e.g. `faces chat:thread socrates -m "…"`) or --id <thread-id> to resume')
      }
      const baseAlias = face_username.split('@')[0]
      const model = flags.llm ? `${baseAlias}@${flags.llm}` : face_username
      const now = new Date().toISOString()
      thread = {
        id: newThreadId(),
        face_username: baseAlias,
        model,
        provider: 'openai',  // refined from the resolved endpoint before sending
        system: flags.system,
        created_at: now,
        updated_at: now,
        messages: [],
      }
    }

    thread.messages.push({role: 'user', content: userMessage, ts: new Date().toISOString()})

    // A face named alone gives only its cause now, never a reply, so a
    // thread needs its model named. Fix the face's default model on the thread,
    // which also moves threads saved before the change onto one.
    const bare = !llmFromArg(thread.model) && !isCompositeFormula(thread.model)

    // Route off the model catalog; cache the endpoint on the thread so resumes
    // (including legacy threads saved before `endpoint` existed) stay consistent.
    let endpoint = thread.endpoint
    if (!endpoint || bare) {
      const route = await resolveEndpoint(client, thread.model)
      if (bare) {
        if (!route.llm) {
          this.error(
            `${thread.model} has no default model to answer on, so name one: ${thread.model}@<model>, or add --llm <model>.`,
          )
        }
        thread.model = `${thread.model}@${route.llm}`
      }
      endpoint = route.endpoint
      thread.endpoint = endpoint
      thread.provider = endpoint === MESSAGES_ENDPOINT ? 'anthropic' : 'openai'
    }

    // Streamed unless --json: a streamed request waits for the face's
    // cause however long it takes, where one that is not has 35s.
    let cause: string | undefined
    try {
      cause = resolveCause(flags.cause, flags['cause-file'])
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    flags = {...flags, cause, stream: flags.stream && !this.jsonEnabled()}

    try {
      let reply: Reply
      if (endpoint === MESSAGES_ENDPOINT) {
        reply = await this.sendAnthropic(client, thread, flags)
      } else if (endpoint === RESPONSES_ENDPOINT) {
        reply = await this.sendResponses(client, thread, flags)
      } else {
        reply = await this.sendChatCompletions(client, thread, flags)
      }
      const assistantText = reply.text
      if (!flags.stream && flags['show-cause'] && reply.reasoning && !this.jsonEnabled()) {
        process.stderr.write(`${reasoningHeading(thread.model)}\n${reply.reasoning}\n\n`)
      }

      const turn: ThreadMessage = {role: 'assistant', content: assistantText, ts: new Date().toISOString()}
      if (reply.reasoning) turn.cause = reply.reasoning
      if (reply.causeId) turn.cause_id = reply.causeId
      if (reply.modelReasoning) turn.reasoning_content = reply.modelReasoning
      thread.messages.push(turn)
      saveThread(thread)

      if (this.jsonEnabled()) {
        return {
          thread_id: thread.id,
          model: thread.model,
          provider: thread.provider,
          assistant: assistantText,
          ...(reply.reasoning ? {cause: reply.reasoning} : {}),
          turns: thread.messages.length,
        }
      }
      if (!flags.stream) this.log(assistantText)
      this.log(`\n[thread ${thread.id}  ·  ${thread.messages.length} turns]`)
      return {thread_id: thread.id, assistant: assistantText}
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.errorCode === 'oauth_rejected') {
          const hints: string[] = []
          if (endpoint === RESPONSES_ENDPOINT) {
            hints.push('This model is free when you link your ChatGPT account: faces auth:connect openai')
          }
          hints.push(
            err.fallbackAvailable
              ? 'Run `faces account:preferences api_fallback true` to allow paid fallback.'
              : 'Run `faces billing:topup` to add credits, then enable fallback with `faces account:preferences api_fallback true`.',
          )
          this.error(`OAuth failed: ${err.message}\n${hints.join('\n')}`)
        }
        // Nothing was answered, so the turn is not saved and the same message
        // can be sent again on the thread.
        const hint = faceRefusalHint(err, thread.model, flags.style)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }
  }

  /** --conversation, --premise and --causes-visible, as request fields. */
  private conversationBody: Record<string, unknown> = {}

  /** Whether only the new message goes out, because a conversation holds the rest. */
  private newOnly = false

  /** The thread's messages to send this turn. */
  private sent(thread: Thread): ThreadMessage[] {
    return this.newOnly ? thread.messages.slice(-1) : thread.messages
  }

  private async sendChatCompletions(
    client: FacesClient,
    thread: Thread,
    flags: {stream: boolean; 'max-tokens'?: number; temperature?: string; style?: string; medium?: string; session?: string; compaction?: string; 'oauth-only': boolean; 'show-cause': boolean; cause?: string},
  ): Promise<Reply> {
    const messages: Array<Record<string, unknown>> = []
    if (thread.system) messages.push({role: 'system', content: thread.system})
    for (const m of this.sent(thread)) messages.push(chatTurn(m))

    const payload: Record<string, unknown> = {model: thread.model, messages, stream: flags.stream}
    if (flags['max-tokens']) payload.max_tokens = flags['max-tokens']
    if (flags.temperature !== undefined) payload.temperature = parseTemperature(flags.temperature, (m) => this.error(m))
    Object.assign(payload, chatExtras(flags), this.conversationBody)
    if (flags['oauth-only']) payload.oauth_only = true
    if (flags.cause) payload.cause = flags.cause

    if (flags.stream) {
      return this.streamAndAccumulate(client, CHAT_COMPLETIONS_ENDPOINT, payload, flags['show-cause'] ? thread.model : undefined)
    }

    let data: unknown
    try {
      ;({data} = await retryOnceOnWarmUp(() => postChat(client, CHAT_COMPLETIONS_ENDPOINT, payload), sayWarmUp))
    } catch (err) {
      // Newer OpenAI models require max_completion_tokens; retry on the provider's
      // own rejection rather than keeping a model list that goes stale.
      if (err instanceof FacesAPIError && isMaxTokensRenameError(err.message) && payload.max_tokens !== undefined) {
        payload.max_completion_tokens = payload.max_tokens
        delete payload.max_tokens
        ;({data} = await retryOnceOnWarmUp(() => postChat(client, CHAT_COMPLETIONS_ENDPOINT, payload), sayWarmUp))
      } else {
        throw err
      }
    }
    return replyOf(data as Record<string, unknown>, CHAT_COMPLETIONS_ENDPOINT)
  }

  private async sendResponses(
    client: FacesClient,
    thread: Thread,
    flags: {stream: boolean; 'max-tokens'?: number; temperature?: string; style?: string; medium?: string; session?: string; compaction?: string; 'oauth-only': boolean; 'show-cause': boolean; cause?: string},
  ): Promise<Reply> {
    // The Responses API is stateless here: replay the full history as the input
    // array each turn, with the system prompt carried in `instructions`.
    const input = this.sent(thread).flatMap((m) => responsesTurns(m))
    const payload: Record<string, unknown> = {model: thread.model, input, stream: flags.stream}
    if (thread.system) payload.instructions = thread.system
    // 0 is falsy, so it skipped the check and went out as no cap at all.
    if (flags['max-tokens'] !== undefined) {
      if (flags['max-tokens'] < MIN_MAX_OUTPUT_TOKENS) {
        throw new Error(
          `--max-tokens must be at least ${MIN_MAX_OUTPUT_TOKENS} for this model (got ${flags['max-tokens']}). ` +
            'The Responses API rejects a smaller output cap.',
        )
      }
      payload.max_output_tokens = flags['max-tokens']
    }
    // Responses takes it too; a model that does not is answered without it,
    // and the server says so in x-faces-dropped-params.
    if (flags.temperature !== undefined) payload.temperature = parseTemperature(flags.temperature, (m) => this.error(m))
    Object.assign(payload, chatExtras(flags), this.conversationBody)
    if (flags['oauth-only']) payload.oauth_only = true
    if (flags.cause) payload.cause = flags.cause

    if (flags.stream) {
      return this.streamAndAccumulate(client, RESPONSES_ENDPOINT, payload, flags['show-cause'] ? thread.model : undefined)
    }

    const {data} = await retryOnceOnWarmUp(() => postChat(client, RESPONSES_ENDPOINT, payload), sayWarmUp)
    return replyOf(data as Record<string, unknown>, RESPONSES_ENDPOINT)
  }

  private async sendAnthropic(
    client: FacesClient,
    thread: Thread,
    flags: {stream: boolean; 'max-tokens'?: number; style?: string; medium?: string; session?: string; compaction?: string; 'oauth-only': boolean; 'show-cause': boolean; cause?: string},
  ): Promise<Reply> {
    const msgs = this.sent(thread).map((m) => messagesTurn(m))
    const payload: Record<string, unknown> = {
      model: thread.model,
      messages: msgs,
      max_tokens: flags['max-tokens'] ?? 1024,
      stream: flags.stream,
    }
    if (thread.system) payload.system = thread.system
    Object.assign(payload, chatExtras(flags), this.conversationBody)
    if (flags['oauth-only']) payload.oauth_only = true
    if (flags.cause) payload.cause = flags.cause

    if (flags.stream) {
      return this.streamAndAccumulate(client, MESSAGES_ENDPOINT, payload, flags['show-cause'] ? thread.model : undefined)
    }

    const {data} = await retryOnceOnWarmUp(() => postChat(client, MESSAGES_ENDPOINT, payload), sayWarmUp)
    return replyOf(data as Record<string, unknown>, MESSAGES_ENDPOINT)
  }

  /**
   * Stream an SSE response, printing deltas to stdout as they arrive while
   * accumulating the full text to persist on the thread. extractStreamDelta
   * dispatches on event type, so it renders whichever endpoint we posted to.
   * The face's cause streams first; given `showReasoningAs`, it goes to
   * stderr under that face's name.
   */
  private async streamAndAccumulate(
    client: FacesClient,
    endpoint: string,
    payload: Record<string, unknown>,
    showReasoningAs?: string,
  ): Promise<Reply> {
    let accum = ''
    let reasoning = ''
    let causeId: string | undefined
    let modelReasoning = ''
    for await (const line of streamChat(client, endpoint, payload)) {
      if (!line.startsWith('data: ')) continue
      const chunk = line.slice(6)
      if (chunk.trim() === '[DONE]' || chunk.trim() === '') continue
      try {
        const parsed = JSON.parse(chunk) as Record<string, unknown>
        const item = parsed.item_id
        if (typeof item === 'string' && item.startsWith(FACES_REASONING_ITEM_PREFIX)) causeId = item
        const own = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0]?.delta as Record<string, unknown> | undefined
        if (own?.reasoning_content) modelReasoning += String(own.reasoning_content)
        const thought = extractStreamReasoning(parsed)
        if (thought) {
          if (showReasoningAs && !reasoning) process.stderr.write(`${reasoningHeading(showReasoningAs)}\n`)
          if (showReasoningAs) process.stderr.write(thought)
          reasoning += thought
        }
        const delta = extractStreamDelta(parsed)
        if (delta) {
          if (showReasoningAs && reasoning && !accum) process.stderr.write('\n\n')
          accum += delta
          process.stdout.write(delta)
        }
      } catch { /* ignore parse errors */ }
    }
    process.stdout.write('\n')
    return {text: accum, reasoning, causeId, modelReasoning: modelReasoning || undefined}
  }
}
