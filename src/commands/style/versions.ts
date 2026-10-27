import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {ownsFace} from '../../utils.js'
import {FacesAPIError} from '../../client.js'
import {EXIT_NO_SUCH_FACE, VERSIONS_PATH, faceExists} from '../../style.js'

interface Version {
  version?: number
  active?: boolean
  model?: string | null
  created_at?: string | null
  /** Which lineage this belongs to. Null for maps built before media existed. */
  medium?: string | null
  /** Whether style:revert would succeed from this row. */
  can_revert?: boolean
  /** How many sources the build behind this version printed. */
  sources_printed?: number | null
}

export default class StyleVersions extends BaseCommand {
  static description =
    'List the styles built for a face, and which one is in use for each medium. A face holds one style per ' +
    'medium, so more than one can be in use at once: an email style and an essay style are separate ' +
    'and do not replace each other. Two versions are kept per medium, which is what style:revert has ' +
    'to go back to.'

  static examples = ['<%= config.bin %> <%= command.id %> alice', '<%= config.bin %> <%= command.id %> alice --json']

  static flags = {...BaseCommand.baseFlags}

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StyleVersions)
    const alias = args.alias
    const client = this.makeClient(flags)

    let data: Record<string, unknown>
    try {
      data = (await client.get(`${VERSIONS_PATH}/${encodeURIComponent(args.alias)}`)) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError && err.statusCode === 404) {
        // The 404 covers both "no style" and "no face". Only one is an error.
        if (await faceExists(client, args.alias)) {
          if (this.jsonEnabled()) return {self_face: args.alias, versions: []}
          // Versions are the owner's to see and make; telling someone to
          // build a style on another account's face sends them to a refusal.
          if ((await ownsFace(client, args.alias)) === false) {
            this.log(`'${args.alias}' belongs to another account. Only its owner can see or build its style versions.`)
            return {self_face: args.alias, versions: []}
          }

          this.log(`'${args.alias}' exists and has no built style yet.`)
          this.log(`Build one with: faces style:make ${args.alias} --all`)
          return {self_face: args.alias, versions: []}
        }
        this.error(`No face named '${args.alias}'. It does not exist, or is not yours.`, {exit: EXIT_NO_SUCH_FACE})
      }
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const versions = (data.versions as Version[]) ?? []
    if (this.jsonEnabled()) return data

    if (versions.length === 0) {
      this.log(`'${args.alias}' has no built style. Build one with: faces style:make ${args.alias} --all`)
      return data
    }

    const rows = versions.map((v) => ({
      // A null medium is a map built before media existed, not a missing value.
      medium: v.medium?.trim() || '(before media)',
      version: String(v.version ?? '-'),
      active: v.active ? 'yes' : '-',
      revert: v.can_revert ? 'yes' : '-',
      sources: v.sources_printed === null || v.sources_printed === undefined ? '-' : String(v.sources_printed),
      model: v.model?.trim() || '-',
      created: String(v.created_at ?? '').slice(0, 19).replace('T', ' ') || '-',
    }))
    const cols: Array<[string, (r: (typeof rows)[0]) => string]> = [
      ['MEDIUM', (r) => r.medium],
      ['VERSION', (r) => r.version],
      ['IN USE', (r) => r.active],
      ['REVERTABLE', (r) => r.revert],
      ['SOURCES', (r) => r.sources],
      ['MODEL', (r) => r.model],
      ['BUILT', (r) => r.created],
    ]
    const w = cols.map(([h, g]) => Math.max(h.length, ...rows.map((r) => g(r).length)))
    const line = (c: string[]) =>
      c.map((x, i) => (cols[i][0] === 'SOURCES' ? x.padStart(w[i]) : x.padEnd(w[i]))).join('  ').trimEnd()
    this.log(line(cols.map(([h]) => h)))
    for (const r of rows) this.log(line(cols.map(([, g]) => g(r))))

    // Several rows are active at once by design: one per medium. Version
    // numbers restart per medium, so a version number alone does not identify
    // a row and the summary names the medium with it.
    const active = versions.filter((v) => v.active)
    const label = (v: Version) => `${v.medium?.trim() || '(before media)'} v${v.version}`
    this.log('')
    if (active.length === 0) {
      this.log(`${versions.length} version(s) kept, none in use.`)
    } else {
      this.log(`In use: ${active.map((v) => label(v)).join(', ')}.`)
      this.log(`${versions.length} version(s) kept in total, two per medium.`)
    }
    const revertable = versions.filter((v) => v.can_revert)
    if (revertable.length > 0) {
      const media = revertable.map((v) => v.medium?.trim()).filter(Boolean)
      this.log(`Can step back: ${revertable.map((v) => label(v)).join(', ')}.`)
      // Say what a revert goes back TO, not just that it can. A confirmation
      // that names the date and the material is a different decision from one
      // that only says "Revert".
      for (const v of revertable) {
        const prior = versions
          .filter((o) => o.medium === v.medium && (o.version ?? 0) < (v.version ?? 0))
          .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]
        if (!prior) continue
        const when = String(prior.created_at ?? '').slice(0, 10)
        const from =
          prior.sources_printed === null || prior.sources_printed === undefined
            ? ''
            : ` from ${prior.sources_printed} source(s)`
        this.log(`  ${label(v)} would go back to v${prior.version}, built ${when}${from}.`)
      }
      if (media.length > 0) this.log(`Use: faces style:revert ${alias} --medium ${media[0]} --yes`)
    }
    return data
  }
}
