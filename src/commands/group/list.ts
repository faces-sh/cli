import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'

export default class GroupList extends BaseCommand {

  static description = 'List your groups'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(GroupList)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/me/groups')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const resp = data as {data?: Array<Record<string, unknown>>}
    let groups = resp.data ?? (data as Array<Record<string, unknown>>)

    // Filter out personal Guild using kind field
    groups = groups.filter(t => t.kind !== 'personal')

    if (this.jsonEnabled()) return groups

    if (groups.length === 0) {
      this.log('(no groups)')
    } else {
      const nameWidth = Math.max(...groups.map(t => String(t.name ?? '').length))
      for (const t of groups) {
        const name = String(t.name ?? '').padEnd(nameWidth)
        const members = t.member_count != null ? `  [${t.member_count} members]` : ''
        const desc = t.description ? `  ${String(t.description).slice(0, 50)}` : ''
        this.log(`${t.id}  ${name}${members}${desc}`)
      }
    }

    return groups
  }
}
