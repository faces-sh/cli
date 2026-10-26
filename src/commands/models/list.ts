import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {table} from '../../utils.js'

const KINDS = ['chat', 'image', 'transcription', 'decision', 'cause', 'compile']

export default class ModelsList extends BaseCommand {
  static description =
    'List the models you can name, once each, with their kind, endpoint and price (GET /v1/models). ' +
    'Without --kind only chat models are listed. CHATGPT marks the Codex-eligible models, which run on a linked ' +
    'ChatGPT plan, at /v1/responses on Connect and Pro. Prices are per million tokens. No login needed.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --kind decision',
    '<%= config.bin %> <%= command.id %> --kind cause,compile',
    '<%= config.bin %> <%= command.id %> --kind all --json',
    '<%= config.bin %> <%= command.id %> --provider anthropic',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    kind: Flags.string({
      description: `One kind or a comma-separated list: ${KINDS.join(', ')}; or all. Default: chat.`,
    }),
    provider: Flags.string({description: 'Only models from this lab (e.g. openai, anthropic, qwen)'}),
    chatgpt: Flags.boolean({
      description: 'Only Codex-eligible models: the ones that run on a linked ChatGPT plan',
      default: false,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ModelsList)
    const client = this.makeClient(flags)

    const kind = flags.kind?.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean).join(',')
    if (kind !== undefined) {
      const parts = kind.split(',')
      const bad = parts.filter((k) => k !== 'all' && !KINDS.includes(k))
      if (bad.length > 0) this.error(`Unknown --kind: ${bad.join(', ')}. One of: ${KINDS.join(', ')}, or all.`)
      if (parts.includes('all') && parts.length > 1) this.error('--kind all cannot be combined with another kind.')
    }

    let raw: unknown
    try {
      raw = await client.get('/v1/models', kind ? {params: {kind}, optionalAuth: true} : {optionalAuth: true})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    let rows = ((Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.data ?? [])) as Array<Record<string, unknown>>)
    if (flags.provider) rows = rows.filter((m) => String(m.provider ?? '').toLowerCase() === flags.provider!.toLowerCase())
    if (flags.chatgpt) rows = rows.filter((m) => m.codex_eligible === true)

    if (this.jsonEnabled()) return {object: 'list', data: rows}

    if (rows.length === 0) {
      this.log('No models.')
      return {object: 'list', data: rows}
    }

    const price = (v: unknown) => (typeof v === 'number' ? `$${v}` : '-')
    const body = rows.map((m) => {
      const unit = typeof m.unit_cost_usd === 'number' && m.billing_unit ? `${price(m.unit_cost_usd)} per ${m.billing_unit}` : ''
      return [
        String(m.id ?? ''),
        String(m.provider ?? '-'),
        String(m.kind ?? '-'),
        String(m.endpoint ?? '-'),
        unit ? '' : price(m.input_cost_per_million_tokens),
        unit ? '' : price(m.output_cost_per_million_tokens),
        unit,
        m.codex_eligible === true ? 'yes' : '',
      ]
    })
    for (const line of table(['MODEL', 'LAB', 'KIND', 'ENDPOINT', 'IN /1M', 'OUT /1M', 'OTHER', 'CHATGPT'], body, new Set(['IN /1M', 'OUT /1M']))) {
      this.log(line)
    }

    const notes: string[] = []
    for (const m of rows) {
      if (typeof m.added_tokens_per_request === 'number' && m.added_tokens_per_request > 0) {
        notes.push(`${m.id}: each request adds ${m.added_tokens_per_request.toLocaleString('en-US')} tokens before pricing.`)
      }
      if (m.token_basis === 'source') notes.push(`${m.id}: priced per million source tokens compiled.`)
      const inc = m.included_tokens_per_month as Record<string, unknown> | null | undefined
      if (inc && typeof inc === 'object') {
        const plans = Object.entries(inc).filter(([, n]) => typeof n === 'number' && n > 0).map(([p, n]) => `${p[0].toUpperCase()}${p.slice(1)} ${(n as number).toLocaleString('en-US')}`)
        if (plans.length > 0) notes.push(`${m.id}: included each month: ${plans.join(', ')} tokens.`)
      }
    }
    if (notes.length > 0) {
      this.log('')
      for (const n of notes) this.log(n)
    }
    return {object: 'list', data: rows}
  }
}
