import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class CompileThreadMessage extends BaseCommand {
  static description = 'Send a user message to a thread'

  static flags = {
    ...BaseCommand.baseFlags,
    message: Flags.string({char: 'm', description: 'User message to append', required: true}),
    'oauth-only': Flags.boolean({description: 'On a linked ChatGPT plan, run there or fail: never fall back to credits', default: false}),
  }

  static args = {
    thread_id: Args.string({description: 'Thread ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadMessage)
    const client = this.makeClient(flags)

    const payload: Record<string, unknown> = {message: flags.message}
    if (flags['oauth-only']) payload.oauth_only = true

    let data: unknown
    try {
      data = await client.post(`/v1/compile/threads/${seg(args.thread_id)}/messages`, {
        body: payload,
      })
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.errorCode === 'oauth_rejected') {
          const hint = err.fallbackAvailable
            ? 'Run `faces account:preferences api_fallback true` to allow paid fallback.'
            : 'Run `faces billing:topup` to add credits, then enable fallback with `faces account:preferences api_fallback true`.'
          this.error(`OAuth failed: ${err.message}\n${hint}`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
