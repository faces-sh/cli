import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {readableLimit} from '../../utils.js'

interface Allowance {
  limit?: number
  used?: number
  remaining?: number | null
  resets_at?: string | null
}

export default class CompileStats extends BaseCommand {
  static description =
    'Show compile usage: your plan, the source tokens compiled this month against its allowance, and the ' +
    'compile rates, standard and rush. For one face\'s numbers, that is face:stats; for what is compiling right ' +
    'now, compile:status.'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CompileStats)
    const client = this.makeClient(flags)

    // Usage comes from the subscription (allowances.compile_month), the rate from the
    // public /v1/rates. /v1/billing/compile-quota is retired.
    let sub: Record<string, unknown>
    let rates: Record<string, unknown>
    try {
      ;[sub, rates] = (await Promise.all([
        client.get('/v1/billing/subscription'),
        client.get('/v1/rates'),
      ])) as [Record<string, unknown>, Record<string, unknown>]
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const plan = typeof sub.plan === 'string' ? sub.plan : 'free'
    const allowances = (sub.allowances ?? null) as Record<string, Allowance> | null
    // A limit of 0 is no allowance: compiles are paid per source token.
    const compile = allowances?.compile_month && allowances.compile_month.limit !== 0 ? allowances.compile_month : null
    const compileRates = (rates.compile ?? {}) as Record<string, unknown>
    const usdPerMillion = typeof compileRates.usd_per_million_source_tokens === 'number'
      ? compileRates.usd_per_million_source_tokens
      : undefined
    const rushPerMillion = typeof compileRates.rush_usd_per_million_source_tokens === 'number'
      ? compileRates.rush_usd_per_million_source_tokens
      : undefined

    const data = {
      plan,
      compile_this_month: compile,
      pay_as_you_go: {usd_per_million_source_tokens: usdPerMillion},
      rush: {usd_per_million_source_tokens: rushPerMillion},
    }

    if (!this.jsonEnabled()) {
      const lines = [`Plan: ${plan}`]
      if (compile) {
        // -1 is the API's unlimited; printed raw it reads as an allowance that has run out.
        const unlimited = typeof compile.limit === 'number' && compile.limit < 0
        const used = (compile.used ?? 0).toLocaleString('en-US')
        if (unlimited) {
          lines.push(`Compiled this month: ${used} source tokens (${readableLimit(compile.limit)})`)
        } else {
          const limit = (compile.limit ?? 0).toLocaleString('en-US')
          const pct = compile.limit ? ` (${Math.round(((compile.used ?? 0) / compile.limit) * 100)}%)` : ''
          const reset = compile.resets_at ? `, resets ${compile.resets_at.slice(0, 10)}` : ''
          lines.push(`Compiled this month: ${used} of ${limit} source tokens${pct}${reset}`)
        }
      } else {
        lines.push('No compile allowance on this plan: compiles are paid per source token.')
      }
      if (usdPerMillion !== undefined) {
        lines.push(`Pay-as-you-go compile rate: $${usdPerMillion} per million source tokens` +
          (compile ? ' (past the allowance, with api_fallback on)' : ''))
      }
      if (rushPerMillion !== undefined) {
        lines.push(`Rush compile rate: $${rushPerMillion} per million source tokens, with --rush on a compile that ` +
          'has a scheduled start' +
          (compile ? '. Within the allowance a rush pays only the difference, from credit.' : '.'))
      }
      this.log(lines.join('\n'))
    }

    return data
  }
}
