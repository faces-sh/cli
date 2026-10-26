import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'

export default class CompileThreadCreate extends BaseCommand {
  static description = 'Start a new thread for a face'

  static flags = {
    ...BaseCommand.baseFlags,
    label: Flags.string({description: 'Thread label'}),
    'oauth-only': Flags.boolean({description: 'On a linked ChatGPT plan, run there or fail: never fall back to credits', default: false}),
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadCreate)
    const client = this.makeClient(flags)

    const payload: Record<string, unknown> = {alias: args.face_id}
    if (flags.label) payload.label = flags.label
    if (flags['oauth-only']) payload.oauth_only = true

    let data: unknown
    try {
      data = await client.post('/v1/compile/threads', {body: payload})
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
