import {BaseCommand} from '../../base.js'

export default class AuthConnections extends BaseCommand {
  static description = 'List connected OAuth provider accounts'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static examples = [
    '<%= config.bin %> auth:connections',
    '<%= config.bin %> auth:connections --json',
  ]

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AuthConnections)
    const client = this.makeClient(flags)

    const data = await client.get('/v1/oauth', {requireJwt: true})

    if (!this.jsonEnabled()) {
      const rows = data as Array<{
        provider: string
        scope?: string
        connected_at: string
        account_email?: string | null
        chatgpt_plan_type?: string | null
      }>
      if (!rows || rows.length === 0) {
        this.log('No connected providers.')
      } else {
        for (const row of rows) {
          if (row.provider === 'openai') {
            const plan = row.chatgpt_plan_type
            const label = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null
            const who = row.account_email ? ` as ${row.account_email}` : ''
            const tier = label ? ` (${label})` : ''
            this.log(`openai  connected${who}${tier}  connected_at=${row.connected_at}`)
            if (!plan || plan === 'free') {
              this.log('  ⚠️  This ChatGPT plan may not include API access. Connecting requires a paid plan (Plus/Pro/Team, etc.).')
            }
          } else {
            this.log(`${row.provider}  connected_at=${row.connected_at}${row.scope ? `  scope=${row.scope}` : ''}`)
          }
        }
      }
    }

    return data
  }
}
