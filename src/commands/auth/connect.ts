import {Args} from '@oclif/core'

import {BaseCommand} from '../../base.js'
import {FacesClient, FacesAPIError} from '../../client.js'

const HARD_STOP_MS = 15 * 60 * 1000 // device codes expire after 15 minutes

interface DeviceStart {
  device_auth_id: string
  user_code: string
  verification_uri: string
  interval: number
  expires_at: string
}

interface DevicePoll {
  status: 'pending' | 'completed' | 'expired'
  retry_after: number | null
  chatgpt_account_id?: string
  chatgpt_plan_type?: string | null
  account_email?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const emit = (msg = '') => process.stderr.write(msg + '\n')

// Unwrap a possible StandardResponse envelope ({data: {...}}) without
// clobbering a flat payload that already has the expected key.
function unwrap<T>(raw: unknown, key: string): T {
  const r = raw as Record<string, unknown>
  if (r && typeof r === 'object' && !(key in r) && r.data && typeof r.data === 'object') {
    return r.data as T
  }
  return raw as T
}

function planLabel(plan?: string | null): string {
  if (!plan) return ''
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}

export default class AuthConnect extends BaseCommand {
  static description = 'Link your ChatGPT account by device-code authorization (Connect and Pro). Codex-eligible models then run on the ChatGPT plan, at /v1/responses.'

  static args = {
    provider: Args.string({
      description: 'OAuth provider to connect',
      required: true,
      options: ['openai'],
    }),
  }

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static examples = [
    '<%= config.bin %> auth:connect openai',
    '<%= config.bin %> auth:connect openai --json',
  ]

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AuthConnect)
    const client = this.makeClient(flags, true)

    // 0. Short-circuit if already connected.
    try {
      const existing = (await client.get('/v1/oauth', {requireJwt: true})) as Array<Record<string, unknown>>
      const row = existing.find((r) => r.provider === 'openai')
      if (row) {
        const email = (row.account_email as string | undefined) ?? null
        const plan = (row.chatgpt_plan_type as string | undefined) ?? null
        const output = {provider: 'openai', connected: true, already_connected: true, account_email: email, chatgpt_plan_type: plan}
        if (!this.jsonEnabled()) {
          const who = email ? ` as ${email}` : ''
          const tier = plan ? ` (${planLabel(plan)})` : ''
          this.log(`Already connected to ChatGPT${who}${tier}. Run 'faces auth:disconnect openai' to reconnect.`)
        }
        return output
      }
    } catch {
      /* ignore: proceed with connect flow */
    }

    // 1. Start the device authorization (backend brokers OpenAI).
    let start: DeviceStart
    try {
      start = await this.startDevice(client)
    } catch (err) {
      this.handleStartError(err)
    }

    const verificationUri = start.verification_uri
    if (!verificationUri) this.error('The server did not return a sign-in address. Try again in a moment.')

    // 2. Cancel the device session if the user aborts (Ctrl-C).
    let done = false
    const onSigint = () => {
      if (done) return
      done = true
      emit('\nAborted. Cancelling device authorization…')
      Promise.race([
        client.post('/v1/oauth/openai/device/cancel', {requireJwt: true, body: {device_auth_id: start.device_auth_id}}).catch(() => {}),
        sleep(2000),
      ]).finally(() => process.exit(130))
    }
    process.once('SIGINT', onSigint)

    // 3. Show the code + URL and the one-time enable-setting guidance.
    emit('')
    emit('To connect ChatGPT:')
    emit(`  1. Open this URL in any browser (phone, laptop, anywhere):`)
    emit(`       ${verificationUri}`)
    emit(`  2. Enter this code:  ${start.user_code}`)
    emit(`  3. Sign in to ChatGPT and click Continue.`)
    emit('')
    emit('If this is your first time, you may need to enable device-code authorization in ChatGPT first:')
    emit("  1. In ChatGPT's Security settings, turn on device code authorization")
    emit('  2. Then enter the code above')
    emit('')
    emit('Waiting for approval (the code expires in 15 minutes; press Ctrl-C to cancel)…')

    // 4. Poll until completed / expired / timed out.
    const startedAt = Date.now()
    const expiresAt = Date.parse(start.expires_at) // NaN if unparseable
    let intervalMs = Math.max(1, start.interval || 5) * 1000

    for (;;) {
      const now = Date.now()
      if (now - startedAt > HARD_STOP_MS || (!Number.isNaN(expiresAt) && now >= expiresAt)) {
        process.removeListener('SIGINT', onSigint)
        this.error('The code expired before it was approved. Run `faces auth:connect openai` again to get a new code.')
      }

      await sleep(intervalMs)

      let poll: DevicePoll
      try {
        const raw = await client.post('/v1/oauth/openai/device/poll', {
          requireJwt: true,
          body: {device_auth_id: start.device_auth_id},
        })
        poll = unwrap<DevicePoll>(raw, 'status')
      } catch (err) {
        // Transient upstream errors: keep polling. Everything else is fatal.
        if (err instanceof FacesAPIError && (err.statusCode === 502 || err.statusCode === 503)) {
          process.stderr.write('.')
          continue
        }
        process.removeListener('SIGINT', onSigint)
        if (err instanceof FacesAPIError) this.error(`Polling failed (${err.statusCode}): ${err.message}`)
        throw err
      }

      if (poll.status === 'completed') {
        done = true
        process.removeListener('SIGINT', onSigint)
        const email = poll.account_email ?? null
        const plan = poll.chatgpt_plan_type ?? null
        const output = {provider: 'openai', connected: true, account_email: email, chatgpt_plan_type: plan}
        if (!this.jsonEnabled()) {
          const who = email ? ` as ${email}` : ''
          const tier = plan ? ` (${planLabel(plan)})` : ''
          this.log(`\n✅ ChatGPT connected${who}${tier}.`)
          if (!plan || plan === 'free') {
            this.log('⚠️  Your ChatGPT plan may not include API access. Connecting requires a paid plan (Plus/Pro/Team, etc.).')
          } else {
            this.log('Codex-eligible models (see faces models:list --chatgpt) now run on your ChatGPT plan, at /v1/responses.')
          }
        }
        return output
      }

      if (poll.status === 'expired') {
        process.removeListener('SIGINT', onSigint)
        this.error('The code expired or was not recognized. Run `faces auth:connect openai` again to get a new code.')
      }

      // pending: honor server-supplied retry_after, else fall back to interval.
      intervalMs = (poll.retry_after && poll.retry_after > 0 ? poll.retry_after : (start.interval || 5)) * 1000
      process.stderr.write('.')
    }
  }

  // Start the device flow, retrying transient upstream (502/503) errors.
  private async startDevice(client: FacesClient): Promise<DeviceStart> {
    let attempts502 = 0
    let attempts503 = 0
    for (;;) {
      try {
        const raw = await client.post('/v1/oauth/openai/device/start', {requireJwt: true})
        return unwrap<DeviceStart>(raw, 'device_auth_id')
      } catch (err) {
        if (err instanceof FacesAPIError && err.statusCode === 503 && attempts503 < 4) {
          attempts503++
          emit('OpenAI is temporarily unavailable, retrying…')
          await sleep(2000)
          continue
        }
        if (err instanceof FacesAPIError && err.statusCode === 502 && attempts502 < 2) {
          attempts502++
          emit('OpenAI returned an error, retrying…')
          await sleep(2000)
          continue
        }
        throw err
      }
    }
  }

  private handleStartError(err: unknown): never {
    if (err instanceof FacesAPIError) {
      if (err.statusCode === 401) {
        this.error('Your Faces session is missing or expired. Run `faces auth:login` and try again.')
      }

      if (err.statusCode === 403 || err.errorCode === 'connect_plan_required') {
        this.error(
          'Connecting ChatGPT requires the Connect or Pro plan.\n' +
          'Subscribe with: faces billing:subscription:activate --plan connect',
        )
      }

      if (err.statusCode === 422 || err.errorCode === 'device_auth_not_enabled') {
        const steps = [
          "In ChatGPT's Security settings, turn on device code authorization",
          'Then run `faces auth:connect openai` again',
        ]
        this.error(
          'Device-code authorization is not enabled on your ChatGPT account yet:\n' +
          steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n'),
        )
      }

      this.error(`Failed to start device authorization (${err.statusCode}): ${err.message}`)
    }
    throw err
  }
}
