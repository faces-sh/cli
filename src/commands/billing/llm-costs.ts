import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {table, usd} from '../../utils.js'
import {llmCostLab} from '../../billing.js'

export default class BillingLlmCosts extends BaseCommand {
  static description =
    'List available LLMs, their per-token costs and what you have spent on each. Models are listed once, ' +
    'under the id their lab gives them. Compile and cause prices, and what each plan includes, are listed ' +
    'after the table. For the full catalog, with endpoints and which models are Codex-eligible, see faces models:list.'

  static flags = {
    ...BaseCommand.baseFlags,
    lab: Flags.string({
      description: 'Filter by the lab that made the model (e.g. openai, anthropic, qwen)',
      aliases: ['provider'],
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingLlmCosts)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/billing/llm-costs')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const lab = llmCostLab
    if (flags.lab && Array.isArray(data)) {
      data = data.filter((row: Record<string, unknown>) => lab(row).toLowerCase() === flags.lab!.toLowerCase())
    }

    if (!this.jsonEnabled()) await this.printTable(client, data as Array<Record<string, unknown>>, lab)
    return data
  }

  /** One line per model, cheapest first within each lab, with the markup said once. */
  private async printTable(
    client: ReturnType<typeof this.makeClient>,
    rows: Array<Record<string, unknown>>,
    lab: (row: Record<string, unknown>) => string,
  ): Promise<void> {
    if (!Array.isArray(rows) || rows.length === 0) {
      this.log('No models.')
      return
    }

    const price = (v: unknown) => (typeof v === 'number' ? `$${v}` : '-')
    const sorted = [...rows].sort((a, b) =>
      lab(a).localeCompare(lab(b)) || Number(a.input_cost_per_million ?? 0) - Number(b.input_cost_per_million ?? 0))
    const body = sorted.map((r) => {
      const unit = typeof r.unit_cost_usd === 'number' && r.billing_unit ? `${price(r.unit_cost_usd)} per ${r.billing_unit}` : ''
      return [String(r.llm_model), lab(r) || '-', unit ? '' : price(r.input_cost_per_million), unit ? '' : price(r.output_cost_per_million), unit, usd(r.user_total_cost_usd)]
    })
    for (const line of table(['MODEL', 'LAB', 'IN /1M', 'OUT /1M', 'OTHER', 'YOU SPENT'], body, new Set(['IN /1M', 'OUT /1M', 'YOU SPENT']))) this.log(line)

    // Each row says its own markup and whether its prices already include it.
    this.log('')
    const rates = new Set(rows.map((r) => `${r.markup_rate}|${r.prices_include_markup}`))
    const [rate, included] = [rows[0].markup_rate, rows[0].prices_include_markup]
    if (rates.size === 1 && typeof rate === 'number') {
      const pct = `${Math.round(rate * 1000) / 10}%`
      this.log(included === true
        ? `Prices are per million tokens and already include the ${pct} markup.`
        : `Listed prices, per million tokens. Requests are charged at these plus a ${pct} markup.`)
    } else {
      this.log('Prices are per million tokens. Markups differ by model; see markup_rate and prices_include_markup in --json.')
    }

    for (const line of await this.facesPrices(client)) this.log(line)
  }

  /** Compiling and a face's cause are priced by Faces, not a lab: from the model catalog. */
  private async facesPrices(client: ReturnType<typeof this.makeClient>): Promise<string[]> {
    let models: Array<Record<string, unknown>>
    try {
      const raw = (await client.get('/v1/models', {params: {kind: 'compile,cause'}})) as Record<string, unknown>
      models = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Array<Record<string, unknown>>
    } catch {
      return []
    }

    const lines: string[] = []
    for (const m of models) {
      const per = m.input_cost_per_million_tokens
      if (typeof per !== 'number') continue
      const markup = m.markup_applies === false ? ', no markup' : ''
      if (m.kind === 'compile') {
        const inc = m.included_tokens_per_month as Record<string, unknown> | undefined
        const plans = inc
          ? Object.entries(inc).filter(([, n]) => typeof n === 'number' && n > 0).map(([p, n]) => `${p[0].toUpperCase()}${p.slice(1)} ${(n as number).toLocaleString('en-US')}`)
          : []
        lines.push(
          `Compiling (${m.id}): $${per} per million source tokens compiled${markup}.` +
            (plans.length > 0 ? ` Included each month: ${plans.join(', ')} tokens; past that, credits pay.` : ''),
        )
      } else if (m.kind === 'cause') {
        const added = typeof m.added_tokens_per_request === 'number' ? ` plus ${m.added_tokens_per_request.toLocaleString('en-US')} tokens a request` : ''
        lines.push(`Causes (${m.id}): $${per} per million input tokens${added}${markup}.`)
      }
    }
    return lines.length > 0 ? ['', ...lines] : []
  }
}
