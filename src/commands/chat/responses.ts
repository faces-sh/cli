import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {postChat, writeReply, resolveCause, causeNeedsModel, CAUSE_FLAG_DESCRIPTION, CAUSE_FILE_FLAG_DESCRIPTION, retryOnceOnWarmUp, sayWarmUp, faceRefusalHint, STREAM_FLAG_DESCRIPTION, extractReasoning, extractStreamReasoning, STYLE_FLAG_DESCRIPTION, MEDIUM_FLAG_DESCRIPTION, SESSION_FLAG_DESCRIPTION, COMPACTION_FLAG_DESCRIPTION, chatExtras, reasoningHeading, reasoningOnlyNote, REASONING_FLAG_DESCRIPTION, MIN_MAX_OUTPUT_TOKENS, parseTemperature, warnDroppedParams, CHAT_PARAM_FLAGS} from '../../utils.js'
import {FacesAPIError} from '../../client.js'
import {conversationFields, conversationTurnFlags} from '../../conversation.js'

export default class ChatResponses extends BaseCommand {
  static description = 'Chat with a face in the OpenAI Responses format (/v1/responses). The same as chat:chat --responses. On Connect and Pro with ChatGPT linked, Codex-eligible models (see faces models:list --chatgpt) run on the ChatGPT plan.'

  static flags = {
    ...BaseCommand.baseFlags,
    message: Flags.string({char: 'm', description: 'User input message', required: true}),
    instructions: Flags.string({description: 'System instructions'}),
    'max-tokens': Flags.integer({description: `Max output tokens (at least ${MIN_MAX_OUTPUT_TOKENS})`}),
    temperature: Flags.string({description: 'Temperature (0.0-2.0)'}),
    stream: Flags.boolean({description: STREAM_FLAG_DESCRIPTION, default: true, allowNo: true}),
    style: Flags.string({description: STYLE_FLAG_DESCRIPTION}),
    medium: Flags.string({description: MEDIUM_FLAG_DESCRIPTION}),
    ...conversationTurnFlags(),
    session: Flags.string({description: SESSION_FLAG_DESCRIPTION}),
    compaction: Flags.string({description: COMPACTION_FLAG_DESCRIPTION}),
    'oauth-only': Flags.boolean({description: 'On a linked ChatGPT plan, run there or fail: never fall back to credits', default: false}),
    'show-cause': Flags.boolean({description: REASONING_FLAG_DESCRIPTION, default: false}),
    cause: Flags.string({description: CAUSE_FLAG_DESCRIPTION}),
    'cause-file': Flags.string({description: CAUSE_FILE_FLAG_DESCRIPTION, exclusive: ['cause']}),
  }

  static args = {
    face_model: Args.string({
    description:
      'Face model, sent as typed (e.g. myface@gpt-4o, head:socrates@gpt-5.4). A face named without a model ' +
      'returns only its cause, with no answer: name the model for one, or use chat:chat, which adds the ' +
      'face\'s default model.',
    required: true,
  }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ChatResponses)
    const client = this.makeClient(flags)

    let turn: Record<string, unknown>
    try {
      turn = conversationFields(flags)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    let cause: string | undefined
    try {
      cause = resolveCause(flags.cause, flags['cause-file'])
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    const model = args.face_model
    // The server refuses a cause with a face named alone (400); say so first.
    if (cause && !model.includes('@')) this.error(causeNeedsModel(model))

    // Streamed unless --json, which wants the whole body and its cost headers.
    const stream = flags.stream && !this.jsonEnabled()
    const payload: Record<string, unknown> = {
      model,
      input: flags.message,
      stream,
    }
    if (flags.instructions) payload.instructions = flags.instructions
    // Responses names the output cap max_output_tokens, and refuses a tiny one.
    if (flags['max-tokens'] !== undefined) {
      if (flags['max-tokens'] < MIN_MAX_OUTPUT_TOKENS) {
        this.error(`--max-tokens must be at least ${MIN_MAX_OUTPUT_TOKENS} (got ${flags['max-tokens']}). The Responses API rejects a smaller output cap.`)
      }
      payload.max_output_tokens = flags['max-tokens']
    }
    if (flags.temperature !== undefined) payload.temperature = parseTemperature(flags.temperature, (m) => this.error(m))
    Object.assign(payload, chatExtras(flags), turn)
    if (flags['oauth-only']) payload.oauth_only = true
    if (cause) payload.cause = cause

    try {
      if (stream) {
        let reasoning = ''
        let replied = false
        for await (const line of client.stream('/v1/responses', payload, {onHeaders: (h) => warnDroppedParams(h, CHAT_PARAM_FLAGS)})) {
          if (!line.startsWith('data: ')) continue
          const chunk = line.slice(6)
          if (chunk.trim() === '[DONE]' || chunk.trim() === '') continue
          try {
            const obj = JSON.parse(chunk) as Record<string, unknown>
            const thought = extractStreamReasoning(obj)
            if (thought) {
              if (flags['show-cause'] && !reasoning) process.stderr.write(`${reasoningHeading(model)}\n`)
              if (flags['show-cause']) process.stderr.write(thought)
              reasoning += thought
            }
            if (obj.type === 'response.output_text.delta') {
              const delta = obj.delta ?? ''
              if (delta) {
                if (flags['show-cause'] && reasoning && !replied) process.stderr.write('\n\n')
                replied = true
                process.stdout.write(String(delta))
              }
            }
          } catch {
            // ignore
          }
        }

        // A bare alias gives the face's cause and no reply. Then the
        // cause is the answer, so it goes where the reply would have.
        if (!replied && reasoning) {
          if (flags['show-cause']) process.stderr.write('\n')
          else process.stdout.write(`${reasoning}\n`)
          process.stderr.write(`\n${reasoningOnlyNote(model, false)}\n`)
        } else {
          process.stdout.write('\n')
        }
        return {}
      }

      const {data, headers} = await retryOnceOnWarmUp(() => postChat(client, '/v1/responses', payload), sayWarmUp)
      const body = data as Record<string, unknown>
      if (!this.jsonEnabled()) warnDroppedParams(headers, CHAT_PARAM_FLAGS)
      if (this.jsonEnabled()) {
        const meta: Record<string, string> = {}
        if (headers['x-faces-provider']) meta.provider = headers['x-faces-provider']
        if (headers['x-faces-cost-usd']) meta.cost_usd = headers['x-faces-cost-usd']
        // oauth (the linked ChatGPT subscription paid, so it cost nothing) or
        // credits. provider names the model's lab now, so it no longer says this.
        if (headers['x-faces-billing']) meta.billing = headers['x-faces-billing']
        if (Object.keys(meta).length > 0) body._meta = meta
        return body
      }

      let outputText = ''
      for (const item of (body.output as Array<Record<string, unknown>>) ?? []) {
        for (const block of (item.content as Array<Record<string, unknown>>) ?? []) {
          if (block.type === 'output_text') outputText += String(block.text ?? '')
        }
      }

      writeReply(model, extractReasoning(body, '/v1/responses'), outputText, flags['show-cause'], reasoningOnlyNote(model, false))
      return body
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.errorCode === 'oauth_rejected') {
          const hint = err.fallbackAvailable
            ? 'Run `faces account:preferences api_fallback true` to allow paid fallback.'
            : 'Run `faces billing:topup` to add credits, then enable fallback with `faces account:preferences api_fallback true`.'
          this.error(`OAuth failed: ${err.message}\n${hint}`)
        }
        const hint = faceRefusalHint(err, model, flags.style)
        this.error(`HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`)
      }
      throw err
    }
  }
}
