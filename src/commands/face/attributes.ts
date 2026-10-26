import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'

export default class FaceAttributes extends BaseCommand {
  static description =
    'List the attribute keys a face can have (its basic_facts): fields that take a bare value, and keys ' +
    'that each take a short sentence. Any other key is refused.'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(FaceAttributes)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get('/v1/faces/attributes')
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      // Two kinds of key: a few fields that take a bare value ("45",
      // "Lisbon, Portugal"), and the rest, each a short sentence. Anything
      // else is refused, so this list is the whole vocabulary.
      const rows = ((data as {data?: unknown}).data ?? []) as Array<{key: string; holds?: string; format?: string}>
      const width = Math.max(0, ...rows.map((r) => r.key.length))
      const groups: Array<[string, string]> = [
        ['value', 'Fields, each a bare value:'],
        ['sentence', 'Keys of short sentences:'],
      ]
      for (const [format, heading] of groups) {
        const these = rows.filter((r) => (r.format ?? 'sentence') === format)
        if (these.length === 0) continue
        this.log(`\n${heading}`)
        for (const r of these) this.log(`  ${r.key.padEnd(width)}  ${r.holds ?? ''}`.trimEnd())
      }
      const known = new Set(groups.map(([f]) => f))
      const other = rows.filter((r) => r.format && !known.has(r.format))
      for (const r of other) this.log(`  ${r.key.padEnd(width)}  ${r.holds ?? ''} (${r.format})`)

      this.log('\nSet them with: faces face:edit <alias> --attr KEY=VALUE\n')
    }

    return data
  }
}
