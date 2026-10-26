import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {isCalendarDate, table, usd} from '../../utils.js'

export default class BillingUsage extends BaseCommand {
  static description = 'Aggregated usage analytics'

  static flags = {
    ...BaseCommand.baseFlags,
    'group-by': Flags.string({
      description: 'Group results',
      options: ['api_key', 'model', 'llm', 'date'],
    }),
    from: Flags.string({description: 'Start date (YYYY-MM-DD)'}),
    to: Flags.string({description: 'End date (YYYY-MM-DD)'}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingUsage)
    const client = this.makeClient(flags)

    const groupByMap: Record<string, string> = {
      api_key: 'api_key_id',
      model: 'llm_model',
      llm: 'llm_model',
      date: 'date',
    }

    // Bad dates came back as an empty report with exit 0, which reads as
    // "no usage" rather than as a mistake.
    for (const [flag, v] of [['--from', flags.from], ['--to', flags.to]] as const) {
      if (v !== undefined && !isCalendarDate(v)) this.error(`${flag} must be a date as YYYY-MM-DD (got "${v}").`)
    }
    if (flags.from && flags.to && flags.from > flags.to) this.error(`--from (${flags.from}) is after --to (${flags.to}).`)

    const params: Record<string, string> = {}
    if (flags['group-by']) params.group_by = groupByMap[flags['group-by']] ?? flags['group-by']
    if (flags.from) params.from = flags.from
    if (flags.to) params.to = flags.to

    let data: unknown
    try {
      data = await client.get('/v1/billing/usage', {params})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printTable(data as {rows?: Array<Record<string, unknown>>}, flags['group-by'])
    return data
  }

  private printTable(data: {rows?: Array<Record<string, unknown>>}, groupBy?: string): void {
    const all = data.rows ?? []
    const rows = all.filter((r) => r.group_key !== '__total__')
    if (rows.length === 0) {
      this.log('No usage in this period.')
      return
    }

    const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : '-')
    const label = (r: Record<string, unknown>) => String(r.group_label ?? r.group_key ?? '(none)')
    const head = (groupBy ?? 'api_key').toUpperCase()
    const sum = (k: string) => rows.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)
    const cols = [head, 'REQUESTS', 'INPUT', 'OUTPUT', 'COST']
    const body = rows.map((r) => [label(r), n(r.request_count), n(r.input_tokens), n(r.output_tokens), usd(r.total_cost_usd)])
    body.push(['total', n(sum('request_count')), n(sum('input_tokens')), n(sum('output_tokens')), usd(sum('total_cost_usd'))])
    for (const line of table(cols, body, new Set(cols.slice(1)))) this.log(line)
  }
}
