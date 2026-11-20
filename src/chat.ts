/**
 * Chat with a face: POST /v1/chat/completions, /v1/responses or /v1/messages.
 *
 * `model` is the upstream model over the downstream one, `@alice:maestro-1/gpt-5.4`:
 * the face steers, and the downstream model writes the reply. The endpoint is
 * picked from the downstream model's entry in the catalog, unless the command
 * forces one. Shared by chat:chat, chat:messages, chat:responses and chat:thread.
 */
import {Flags} from '@oclif/core'
import {FacesAPIError, FacesClient, type ResponseWithHeaders} from './client.js'
import {conversationTurnFlags} from './conversation.js'
import {modelProblem, parseModel} from './model.js'
import {CHAT_COMPLETIONS_ENDPOINT, MESSAGES_ENDPOINT, RESPONSES_ENDPOINT} from './routing.js'
import {
  CHAT_PARAM_FLAGS,
  COMPACTION_FLAG_DESCRIPTION,
  MIN_MAX_OUTPUT_TOKENS,
  SESSION_FLAG_DESCRIPTION,
  STREAM_FLAG_DESCRIPTION,
  extractStreamDelta,
  isMaxTokensRenameError,
  postChat,
  retryOnceOnWarmUp,
  sayWarmUp,
  streamChat,
  warnDroppedParams,
} from './utils.js'

export type ChatEndpoint = typeof CHAT_COMPLETIONS_ENDPOINT | typeof RESPONSES_ENDPOINT | typeof MESSAGES_ENDPOINT

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  system?: string
  maxTokens?: number
  temperature?: number
  stream: boolean
  oauthOnly?: boolean
  session?: string
  compaction?: string
  /** --conversation, --premise and --causes-visible, as request fields. */
  turn?: Record<string, unknown>
}

export const MODEL_ARG_DESCRIPTION =
  'The upstream model over the downstream model: @<face>:<maestro>/<model>, e.g. @alice:maestro-1/gpt-5.4. ' +
  'Another account\'s face is @owner~face; a composite is "(@a | @b):maestro-1/<model>" (operators | & - ^). ' +
  'maestro-1-flash steers sooner, at 10 times the steering price. The model after the / is any chat model ' +
  'in faces models:list, written as it is listed.'

/** The flags every chat command takes. */
export function chatFlags() {
  return {
    message: Flags.string({char: 'm', description: 'Your message (repeatable, sent in order).', multiple: true}),
    file: Flags.string({description: 'Read the message from a file.'}),
    system: Flags.string({description: 'System prompt (instructions on /v1/responses).'}),
    stream: Flags.boolean({description: STREAM_FLAG_DESCRIPTION, default: true, allowNo: true}),
    'max-tokens': Flags.integer({description: 'The most tokens the reply may take (at least 1; 16 on /v1/responses).', min: 1}),
    temperature: Flags.string({description: 'Temperature (0.0-2.0).'}),
    ...conversationTurnFlags(),
    session: Flags.string({description: SESSION_FLAG_DESCRIPTION}),
    compaction: Flags.string({description: COMPACTION_FLAG_DESCRIPTION}),
    'oauth-only': Flags.boolean({description: 'On a linked ChatGPT plan, run there or fail: never fall back to credits.', default: false}),
  }
}

/** What is wrong with a chat `model` before anything is sent, or undefined. */
export function chatModelProblem(model: string): string | undefined {
  return modelProblem(model, 'both')
}

/** The request body for `endpoint`. */
export function chatPayload(endpoint: string, model: string, turns: Turn[], o: ChatOptions): Record<string, unknown> {
  let payload: Record<string, unknown>
  if (endpoint === MESSAGES_ENDPOINT) {
    payload = {model, messages: turns.map((t) => ({role: t.role, content: t.content})), max_tokens: o.maxTokens ?? 1024, stream: o.stream}
    if (o.system) payload.system = o.system
  } else if (endpoint === RESPONSES_ENDPOINT) {
    payload = {model, input: turns.map((t) => ({role: t.role, content: t.content})), stream: o.stream}
    if (o.system) payload.instructions = o.system
    if (o.maxTokens !== undefined) {
      if (o.maxTokens < MIN_MAX_OUTPUT_TOKENS) {
        throw new Error(`--max-tokens must be at least ${MIN_MAX_OUTPUT_TOKENS} on /v1/responses (got ${o.maxTokens}).`)
      }
      payload.max_output_tokens = o.maxTokens
    }
  } else {
    const messages: Array<Record<string, unknown>> = []
    if (o.system) messages.push({role: 'system', content: o.system})
    for (const t of turns) messages.push({role: t.role, content: t.content})
    payload = {model, messages, stream: o.stream}
    if (o.maxTokens !== undefined) payload.max_tokens = o.maxTokens
  }
  if (o.temperature !== undefined) payload.temperature = o.temperature
  if (o.session) payload.session = o.session
  if (o.compaction) payload.compaction = o.compaction
  if (o.turn) Object.assign(payload, o.turn)
  if (o.oauthOnly) payload.oauth_only = true
  return payload
}

/** The reply's text, by the endpoint that answered. */
export function replyText(body: Record<string, unknown>, endpoint: string): string {
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
  const choices = body.choices as Array<Record<string, unknown>> | undefined
  return String((choices?.[0]?.message as Record<string, unknown> | undefined)?.content ?? '')
}

/** The cost and billing headers, for --json. */
export function chatMeta(headers: Record<string, string>, endpoint: string, model: string): Record<string, string> {
  const meta: Record<string, string> = {}
  if (headers['x-faces-provider']) meta.provider = headers['x-faces-provider']
  if (headers['x-faces-cost-usd']) meta.cost_usd = headers['x-faces-cost-usd']
  // oauth (the linked ChatGPT subscription paid) or credits.
  if (headers['x-faces-billing']) meta.billing = headers['x-faces-billing']
  meta.endpoint = endpoint
  meta.model = model
  return meta
}

export interface ChatResult {
  text: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

/**
 * Send one chat request. Streamed: each piece of the reply goes to
 * `onDelta` as it arrives. Not streamed: the whole reply, retried once on a
 * warm-up 503, and once with `max_completion_tokens` when the model refuses
 * `max_tokens`.
 */
export async function sendChat(
  client: FacesClient,
  endpoint: string,
  payload: Record<string, unknown>,
  onDelta: (text: string) => void,
  quiet = false,
): Promise<ChatResult> {
  if (payload.stream) {
    let text = ''
    const onHeaders = (headers: Record<string, string>) => warnDroppedParams(headers, CHAT_PARAM_FLAGS)
    for await (const line of streamChat(client, endpoint, payload, onHeaders)) {
      if (!line.startsWith('data: ')) continue
      const chunk = line.slice(6).trim()
      if (chunk === '[DONE]' || chunk === '') continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(chunk) as Record<string, unknown>
      } catch {
        continue
      }
      // A refusal after the stream started arrives as one error event.
      const error = parsed.error as Record<string, unknown> | undefined
      if (parsed.type === 'error' || (error && typeof error === 'object' && !parsed.choices)) {
        const inner = (error ?? parsed) as Record<string, unknown>
        const status = Number(inner.status ?? parsed.status ?? 500)
        throw new FacesAPIError(status, String(inner.message ?? parsed.message ?? 'The stream ended with an error.'))
      }
      const delta = extractStreamDelta(parsed)
      if (delta) {
        text += delta
        onDelta(delta)
      }
    }
    return {text}
  }

  const say = quiet ? undefined : sayWarmUp
  let res: ResponseWithHeaders
  try {
    res = await retryOnceOnWarmUp(() => postChat(client, endpoint, payload), say)
  } catch (err) {
    if (err instanceof FacesAPIError && isMaxTokensRenameError(err.message) && payload.max_tokens !== undefined) {
      payload.max_completion_tokens = payload.max_tokens
      delete payload.max_tokens
      res = await retryOnceOnWarmUp(() => postChat(client, endpoint, payload), say)
    } else {
      throw err
    }
  }
  if (!quiet) warnDroppedParams(res.headers, CHAT_PARAM_FLAGS)
  const body = res.data as Record<string, unknown>
  return {text: replyText(body, endpoint), body, headers: res.headers}
}

/** The face part of a chat model, for hints: `alice` from `@alice:maestro-1/gpt-5.4`. */
export function faceOfModel(model: string): string {
  const faces = parseModel(model).faces ?? model
  return faces.replace(/^@/, '').replace('~', ':')
}

export {CHAT_COMPLETIONS_ENDPOINT, MESSAGES_ENDPOINT, RESPONSES_ENDPOINT}
