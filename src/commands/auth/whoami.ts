import {BaseCommand} from '../../base.js'
import {FacesClient, FacesAPIError} from '../../client.js'
import {resolveBaseUrl, resolveCredentials} from '../../config.js'

export default class AuthWhoami extends BaseCommand {
  static description = 'Print current user profile and auth diagnostic'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AuthWhoami)
    const baseUrl = resolveBaseUrl(flags['base-url'])
    const {token, apiKey, withheld, keySaved} = resolveCredentials(flags, baseUrl)
    const json = this.jsonEnabled()

    const diag: Record<string, unknown> = {
      base_url: baseUrl,
      jwt_configured: Boolean(token),
      api_key_configured: Boolean(apiKey),
      api_key_prefix: apiKey ? apiKey.slice(0, 12) + '...' : null,
    }

    if (!apiKey && !token) {
      diag.authenticated = false
      diag.error = withheld ?? 'No credentials configured (no API key, no JWT)'
      if (!json) {
        this.log('Auth diagnostic:')
        this.log(`  base_url:       ${baseUrl}`)
        this.log(`  jwt:            not configured`)
        this.log(`  api_key:        not configured`)
        this.log(`  status:         not authenticated`)
        if (withheld) this.log(`  note:           ${withheld}`)
      }
      if (json) process.stdout.write(JSON.stringify(diag, null, 2) + '\n')
      process.exit(1)
    }

    // Try API key first (priority), then JWT. Always try both and report.
    let apiKeyResult: {ok: boolean; error?: string; data?: Record<string, unknown>} | null = null
    let jwtResult: {ok: boolean; error?: string; data?: Record<string, unknown>} | null = null

    if (apiKey) {
      const client = new FacesClient(baseUrl, undefined, apiKey)
      try {
        const data = await client.get('/auth/me') as Record<string, unknown>
        apiKeyResult = {ok: true, data: (data.data ?? data) as Record<string, unknown>}
      } catch (err) {
        const msg = err instanceof FacesAPIError ? `${err.statusCode}: ${err.message}` : String(err)
        apiKeyResult = {ok: false, error: msg}
      }
    }

    if (token) {
      // Only try JWT if API key failed or wasn't configured
      if (!apiKeyResult?.ok) {
        const client = new FacesClient(baseUrl, token, undefined)
        try {
          const data = await client.get('/auth/me') as Record<string, unknown>
          jwtResult = {ok: true, data: (data.data ?? data) as Record<string, unknown>}
        } catch (err) {
          const msg = err instanceof FacesAPIError ? `${err.statusCode}: ${err.message}` : String(err)
          jwtResult = {ok: false, error: msg}
        }
      }
    }

    // What other commands will actually do: the API key goes first, and only a
    // saved one that is refused falls back to the saved login. A key passed for
    // this run that fails is a failure, whatever the login would have said.
    const keyFailed = Boolean(apiKey) && !apiKeyResult?.ok
    const fallsBack = keyFailed && keySaved && Boolean(jwtResult?.ok)
    const winner = apiKeyResult?.ok ? apiKeyResult : (!apiKey || fallsBack) && jwtResult?.ok ? jwtResult : null
    const winnerMethod = apiKeyResult?.ok ? 'api_key' : winner ? 'jwt' : null
    if (fallsBack) diag.warning = 'The saved API key is refused, so commands fall back to the saved login. Remove the key with: faces config:set api_key ""'

    diag.authenticated = Boolean(winner)
    diag.auth_method = winnerMethod
    if (apiKeyResult) diag.api_key_status = apiKeyResult.ok ? 'valid' : apiKeyResult.error
    if (jwtResult) diag.jwt_status = jwtResult.ok ? 'valid' : jwtResult.error

    if (winner?.data) {
      diag.user_id = winner.data.user_id
      diag.username = winner.data.username
      diag.email = winner.data.email
      diag.name = winner.data.name
    } else {
      diag.error = 'All credentials failed'
    }

    if (!json) {
      // stdout, so `faces auth:whoami | grep status` finds it.
      const jwtLine = !token ? 'not configured' : jwtResult ? (jwtResult.ok ? 'valid' : `failed (${jwtResult.error})`) : 'not checked (the API key works)'
      this.log('Auth diagnostic:')
      this.log(`  base_url:       ${baseUrl}`)
      this.log(`  jwt:            ${jwtLine}`)
      this.log(`  api_key:        ${apiKey ? (apiKeyResult?.ok ? `valid (${diag.api_key_prefix})` : `failed (${apiKeyResult?.error})`) : 'not configured'}`)
      this.log(`  auth_method:    ${winnerMethod ?? 'none'}`)
      this.log(`  status:         ${winner ? 'authenticated' : 'failed'}`)
      if (diag.warning) this.log(`  warning:        ${diag.warning}`)
      if (winner?.data) {
        this.log('')
        this.log(`  user_id:        ${winner.data.user_id}`)
        this.log(`  username:       ${winner.data.username}`)
        this.log(`  email:          ${winner.data.email}`)
        this.log(`  name:           ${winner.data.name}`)
      }
    }

    if (!diag.authenticated) {
      if (json) process.stdout.write(JSON.stringify(diag, null, 2) + '\n')
      process.exit(1)
    }

    return diag
  }
}
