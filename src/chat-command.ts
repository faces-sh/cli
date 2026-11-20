import {Args} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from './base.js'
import {FacesAPIError, FacesClient} from './client.js'
import {conversationFields} from './conversation.js'
import {chatgptLinked} from './style.js'
import {
  CHAT_COMPLETIONS_ENDPOINT,
  MODEL_ARG_DESCRIPTION,
  RESPONSES_ENDPOINT,
  chatFlags,
  chatMeta,
  chatModelProblem,
  chatPayload,
  sendChat,
  type Turn,
} from './chat.js'
import {parseModel} from './model.js'
import {resolveEndpoint} from './routing.js'
import {faceRefusalHint, parseTemperature} from './utils.js'

/** What chat:chat, chat:messages and chat:responses share; each names its endpoint. */
export abstract class ChatCommand extends BaseCommand {
  static flags = {
    ...BaseCommand.baseFlags,
    ...chatFlags(),
  }

  static args = {
    model: Args.string({description: MODEL_ARG_DESCRIPTION, required: true}),
  }

  /** The endpoint this command always uses, or undefined to route from the catalog. */
  protected abstract forcedEndpoint(flags: Record<string, unknown>): string | undefined

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(this.constructor as typeof ChatCommand)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    const model = args.model.trim()
    const problem = chatModelProblem(model)
    if (problem) this.error(problem)

    const turns: Turn[] = []
    if (flags.file) {
      if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
      turns.push({role: 'user', content: fs.readFileSync(flags.file, 'utf8')})
    }
    for (const m of flags.message ?? []) turns.push({role: 'user', content: m})
    if (turns.length === 0) this.error('Provide at least one --message/-m or --file.')

    let turn: Record<string, unknown>
    try {
      turn = conversationFields(flags)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    const downstream = parseModel(model).downstream as string
    const route = await resolveEndpoint(client, downstream)
    const endpoint = this.forcedEndpoint(flags) ?? route.endpoint
    const temperature = flags.temperature === undefined ? undefined : parseTemperature(flags.temperature, (m) => this.error(m))

    let payload: Record<string, unknown>
    try {
      payload = chatPayload(endpoint, model, turns, {
        system: flags.system,
        maxTokens: flags['max-tokens'],
        temperature,
        // --json wants the whole body and its cost headers.
        stream: flags.stream && !json,
        oauthOnly: flags['oauth-only'],
        session: flags.session,
        compaction: flags.compaction,
        turn,
      })
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    try {
      const res = await sendChat(client, endpoint, payload, (d) => process.stdout.write(d), json)
      if (payload.stream) {
        if (!res.text) this.error('The reply stream ended with no answer. Run it again with --no-stream to see what the server said.')
        process.stdout.write('\n')
        return {}
      }
      if (json) {
        const body = res.body ?? {}
        body._meta = chatMeta(res.headers ?? {}, endpoint, model)
        return body
      }
      this.log(res.text)
      return res.body
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(await chatRefusal(err, model, endpoint, route.freeWhenConnected, client))
      throw err
    }
  }
}

/** A chat refusal, with what to do about it. */
export async function chatRefusal(err: FacesAPIError, model: string, endpoint: string, freeWhenConnected: boolean, client: FacesClient): Promise<string> {
  if (err.errorCode === 'oauth_rejected') {
    const hints: string[] = []
    const linked = await chatgptLinked(client)
    if (linked === false) hints.push('No ChatGPT account is linked. Link one with: faces auth:connect openai')
    else hints.push('If the ChatGPT link has lapsed, link it again with: faces auth:connect openai')
    if (endpoint === RESPONSES_ENDPOINT && freeWhenConnected && linked === false) hints.push('This model is free once it is linked.')
    hints.push(
      err.fallbackAvailable
        ? 'Or allow paid fallback: faces account:preferences api_fallback true'
        : 'Or add credits (faces billing:topup --amount <usd>) and allow paid fallback: faces account:preferences api_fallback true',
    )
    return `OAuth failed: ${err.message}\n${hints.join('\n')}`
  }
  if (err.errorCode === 'model_not_supported') {
    return `${err.message}\nYour ChatGPT plan does not serve this model. Name another after the /, or let it run on credits: faces account:preferences api_fallback true`
  }
  if (err.errorCode === 'use_responses_for_free_oauth' && endpoint === CHAT_COMPLETIONS_ENDPOINT) {
    return `HTTP ${err.statusCode}: ${err.message}\nRun it on your ChatGPT plan with --responses (or faces chat:responses).`
  }
  const hint = faceRefusalHint(err, model)
  return `HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`
}
