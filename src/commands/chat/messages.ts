import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {postChat, writeReply, resolveCause, causeNeedsModel, CAUSE_FLAG_DESCRIPTION, CAUSE_FILE_FLAG_DESCRIPTION, retryOnceOnWarmUp, sayWarmUp, faceRefusalHint, STREAM_FLAG_DESCRIPTION, extractReasoning, extractStreamReasoning, STYLE_FLAG_DESCRIPTION, MEDIUM_FLAG_DESCRIPTION, SESSION_FLAG_DESCRIPTION, COMPACTION_FLAG_DESCRIPTION, chatExtras, reasoningHeading, reasoningOnlyNote, REASONING_FLAG_DESCRIPTION} from '../../utils.js'
import {FacesAPIError} from '../../client.js'

export default class ChatMessages extends BaseCommand {
  static description = 'Chat with a face in the Anthropic Messages format (/v1/messages). chat:chat routes Anthropic models here on its own.'

  static flags = {
    ...BaseCommand.baseFlags,
    message: Flags.string({char: 'm', description: 'User message (repeatable)', multiple: true, required: true}),
    system: Flags.string({description: 'System prompt'}),
    stream: Flags.boolean({description: STREAM_FLAG_DESCRIPTION, default: true, allowNo: true}),
    'max-tokens': Flags.integer({description: 'Max tokens (at least 1)', default: 1024, min: 1}),
    style: Flags.string({description: STYLE_FLAG_DESCRIPTION}),
    medium: Flags.string({description: MEDIUM_FLAG_DESCRIPTION}),
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
      'Face model, sent as typed (e.g. myface@claude-sonnet-4-6, head:socrates@claude-sonnet-4-6). A face named without a model ' +
      'returns only its cause, with no answer: name the model for one, or use chat:chat, which adds the ' +
      'face\'s default model.',
    required: true,
  }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ChatMessages)
    const client = this.makeClient(flags)

    const msgs = flags.message.map((m) => ({role: 'user', content: m}))
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
      messages: msgs,
      max_tokens: flags['max-tokens'],
      stream,
    }
    if (flags.system) payload.system = flags.system
    Object.assign(payload, chatExtras(flags))
    if (flags['oauth-only']) payload.oauth_only = true
    if (cause) payload.cause = cause

    try {
      if (stream) {
        let reasoning = ''
        let replied = false
        for await (const line of client.stream('/v1/messages', payload)) {
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
            if (obj.type === 'content_block_delta') {
              const delta = (obj.delta as Record<string, unknown>)?.text ?? ''
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

      const {data, headers} = await retryOnceOnWarmUp(() => postChat(client, '/v1/messages', payload), sayWarmUp)
      const body = data as Record<string, unknown>
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

      let content = ''
      for (const block of (body.content as Array<Record<string, unknown>>) ?? []) {
        if (block.type === 'text') content += String(block.text ?? '')
      }

      writeReply(model, extractReasoning(body, '/v1/messages'), content, flags['show-cause'], reasoningOnlyNote(model, false))
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
