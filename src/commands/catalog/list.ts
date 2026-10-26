import fs from 'node:fs'
import {BaseCommand} from '../../base.js'
import {CATALOG_INDEX} from '../../catalog.js'

export default class CatalogList extends BaseCommand {
  static description = 'List all faces in the local catalog'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    let entries: Array<Record<string, unknown>> = []
    try {
      if (fs.existsSync(CATALOG_INDEX)) {
        entries = JSON.parse(fs.readFileSync(CATALOG_INDEX, 'utf8'))
      }
    } catch {
      this.error('Could not read catalog.json')
    }

    if (this.jsonEnabled()) return entries

    if (entries.length === 0) {
      this.log('(no faces in the local catalog. If you have faces on your account, sync them with: faces catalog:doctor --fix)')
      return entries
    }

    // Capped, and stripped of text-direction controls, so one odd name cannot
    // pad every row past the screen or reverse the rest of its line.
    const clean = (v: unknown, max: number) => {
      const t = String(v ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
      return t.length > max ? `${t.slice(0, max - 3)}...` : t
    }
    const nameWidth = Math.max(...entries.map((e) => clean(e.alias, 40).length))
    const displayWidth = Math.max(...entries.map((e) => clean(e.name, 40).length))
    for (const e of entries) {
      const alias = clean(e.alias, 40).padEnd(nameWidth)
      const name = clean(e.name, 40).padEnd(displayWidth)
      const desc = e.description ? `  ${String(e.description).slice(0, 60)}...` : ''
      this.log(`${alias}  ${name}${desc}`)
    }

    return entries
  }
}
