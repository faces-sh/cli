import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {renameFaceFields, faceStyles, readablePatternError} from '../../utils.js'

interface FaceObject {
  alias: string
  name: string
  published?: boolean
  owned_by?: string | null
  formula?: string | null
  component_counts?: number[] | null
  /** Styles installed, keyed by kind, each listing the media it can speak in. */
  /** The media the face has a built style for; empty when none. */
  styles?: string[] | null
  /** How a shared face reached you: "shared", "workspace", or both. Absent on your own and on published faces. */
  via?: string[] | null
  read_only?: boolean
  /** The short line saying what this face is for. */
  specialty?: string | null
  /** Last change to the face itself, not to its compiled material. */
  updated_at?: string | null
  /** Counters, only with --include usage. */
  usage?: Record<string, number> | null
  /**
   * The generated avatar: 'none', 'current' or 'stale'. Only with
   * --include avatar, and it says nothing about an uploaded picture, which
   * `avatar_uploaded` reports separately.
   */
  avatar_status?: string | null
  avatar_uploaded?: boolean | null
  avatar_version?: number | null
  /** The owner's own picture, and whether you follow them. Only with --include owner_follow. */
  owner_avatar?: string | null
  owner_followed?: boolean | null
}

/** Curated system faces are served under this owner account. */
const SYSTEM_OWNER = 'head'

export default class FaceList extends BaseCommand {
  static description =
    'List faces. By default lists owned faces, newest first; use --public to include published faces ' +
    'from other accounts, --search to match on text, and --sort/--order to change the ordering.'

  static flags = {
    ...BaseCommand.baseFlags,
    tag: Flags.string({description: 'Filter by tag (repeatable, AND logic)', multiple: true}),
    group: Flags.string({
      description: 'Filter by group ID (repeatable, OR logic)',
      multiple: true,
    }),
    include: Flags.string({
      description:
        'Extra fields, comma-separated: tags, groups, profile, sharing, avatar, usage, owner_follow. ' +
        '`avatar` says whether each generated avatar is current or stale; `owner_follow` says whether ' +
        'you follow the account that published a face.',
    }),
    public: Flags.boolean({description: 'Include published faces from other accounts (open to everybody)'}),
    'has-style': Flags.boolean({
      description: 'Show only faces with a built style',
      default: false,
    }),
    shared: Flags.boolean({description: 'Include faces other accounts have shared with YOU in particular'}),
    system: Flags.boolean({description: `Show only the curated system faces (published faces owned by '${SYSTEM_OWNER}')`}),
    'from-users': Flags.string({description: 'Only published faces from these owners (repeatable/comma-separated)', multiple: true}),
    'not-from-users': Flags.string({description: 'Exclude published faces from these owners (repeatable/comma-separated)', multiple: true}),
    // Passed through without a local enum, the same way --medium is: the route
    // answers 422 naming the valid values, and the set may grow. A future
    // --reverse belongs on `order=desc`; the names that read naturally for it
    // (reverse, direction, sort_dir, descending) are each refused by the API.
    sort: Flags.string({
      description:
        'What to order by: created, alias, relevance or usage. relevance ranks by how well a face ' +
        'matches --search, so it needs one.',
    }),
    order: Flags.string({
      description:
        'asc or desc. Omit it to keep each field\'s own direction, which is newest first for created, ' +
        'most used first for usage, best match first for relevance, and A to Z for alias.',
    }),
    search: Flags.string({
      description: 'Only faces whose alias, name or description matches this text',
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(FaceList)
    for (const t of flags.group ?? []) {
      // A name or typo matched nothing and read as an empty catalog.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
        this.error(`--group takes a group id (got "${t}"). Find ids with: faces group:list`)
      }
    }

    const client = this.makeClient(flags)

    // Split comma-separated owner lists into individual values.
    const split = (vals?: string[]): string[] =>
      (vals ?? []).flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)
    const fromUsers = split(flags['from-users'])
    if (flags.system) fromUsers.push(SYSTEM_OWNER)
    const notFromUsers = split(flags['not-from-users'])

    if (fromUsers.length > 0 && notFromUsers.length > 0) {
      this.error('--from-users and --not-from-users are mutually exclusive')
    }

    // relevance is a ranking against a search term. Without one the server has
    // nothing to rank and falls back to the default order, which looks like the
    // sort was ignored rather than unusable.
    if (flags.sort === 'relevance' && !flags.search) {
      this.error('--sort relevance ranks by how well a face matches --search, so it needs one.')
    }

    // Any cross-account owner filter implies we want published faces.
    const includePublished = flags.public || flags.system || fromUsers.length > 0 || notFromUsers.length > 0

    // Build query string manually for repeated params
    const parts: string[] = []
    if (flags.tag && flags.tag.length > 0) {
      for (const t of flags.tag) parts.push(`tag=${encodeURIComponent(t)}`)
    }
    if (flags.group && flags.group.length > 0) {
      for (const t of flags.group) parts.push(`group_id=${encodeURIComponent(t)}`)
    }
    if (flags.include) parts.push(`include=${encodeURIComponent(flags.include)}`)
    if (flags.sort) parts.push(`sort=${encodeURIComponent(flags.sort)}`)
    // Only sent when asked for. Each field has its own direction and sending a
    // direction it already had would read as a no-op while silently flipping
    // the others.
    if (flags.order) parts.push(`order=${encodeURIComponent(flags.order)}`)
    if (flags.search) parts.push(`q=${encodeURIComponent(flags.search)}`)
    if (includePublished) parts.push('include_published=true')
    if (flags.shared) parts.push('include_shared=true')
    for (const u of fromUsers) parts.push(`from_users=${encodeURIComponent(u)}`)
    for (const u of notFromUsers) parts.push(`not_from_users=${encodeURIComponent(u)}`)

    let data: unknown
    let truncated = false
    try {
      const path = parts.length > 0 ? `/v1/faces?${parts.join('&')}` : '/v1/faces'
      // Every page, not just the first: the list route is cursor-paginated, and
      // stopping at page one hides faces without saying anything.
      const all = await client.getAll(path)
      truncated = all.truncated
      data = {object: 'list', data: all.data, has_more: all.truncated, next_cursor: null}
    } catch (err) {
      if (err instanceof FacesAPIError) {
        // A rejected --sort or --order arrives as a regex. Say it in words.
        if (err.statusCode === 422) this.error(readablePatternError(err.message))
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }

      throw err
    }

    // Rename basic_facts → attributes in response
    const raw = (data as {data?: FaceObject[]}).data ?? (data as FaceObject[])
    for (const f of raw as unknown as Array<Record<string, unknown>>) {
      renameFaceFields(f)
    }

    // The API's from_users/not_from_users used to constrain only the appended
    // published set, so the caller's own faces always came back. The server now
    // narrows both sets itself, so this removes nothing there. It stays as a guard against an older deployment,
    // where --system / --from-users / --not-from-users would otherwise lie.
    let faces = raw as FaceObject[]
    if (flags['has-style']) faces = faces.filter(f => faceStyles(f).length > 0)
    if (fromUsers.length > 0) {
      const allow = new Set(fromUsers)
      faces = faces.filter(f => f.owned_by != null && allow.has(f.owned_by))
    } else if (notFromUsers.length > 0) {
      const block = new Set(notFromUsers)
      faces = faces.filter(f => f.owned_by == null || !block.has(f.owned_by))
    }
    // Keep --json output consistent with what we display.
    if ((data as {data?: unknown}).data !== undefined) (data as {data: unknown}).data = faces
    else data = faces

    if (!this.jsonEnabled()) {
      // Published faces are chatted as `owner:alias`; own faces stay bare.
      // A face you do not own needs the owner prefix to resolve at all. Both
      // published and shared faces are someone else's, and only those two carry
      // `published` / `via`, so either marks the alias as needing qualifying.
      const isForeign = (f: FaceObject): boolean => Boolean(f.published || f.via?.length)
      const handle = (f: FaceObject): string =>
        isForeign(f) && f.owned_by ? `${f.owned_by}:${f.alias}` : f.alias
      if (faces.length === 0) {
        this.log('(no faces)')
      } else {
        const handleWidth = Math.max(...faces.map(f => handle(f).length))
        const nameWidth = Math.max(...faces.map(f => f.name.length))
        for (const f of faces) {
          let suffix = ''
          if (f.formula) {
            suffix = `  [composite: ${f.formula}]`
          }
          // A face with a captured style answers as the person rather than as a
          // generic assistant, so it is worth seeing at a glance which do. The
          // media are shown with it because they are what --style may ask for.
          const media = faceStyles(f)
          if (media.length > 0) suffix += `  [style: ${media.join(', ')}]`
          // Avatar state only arrives with --include avatar, so its absence
          // means nothing was asked rather than nothing is there. The generated
          // avatar and an uploaded picture are separate things and both are
          // worth naming.
          if (f.avatar_status) {
            const v = f.avatar_version ? ` v${f.avatar_version}` : ''
            suffix += f.avatar_status === 'none' ? '' : `  [avatar: ${f.avatar_status}${v}]`
          }
          if (f.avatar_uploaded) suffix += '  [uploaded picture]'
          if (f.owner_followed) suffix += '  [you follow the owner]'

          if (f.via?.length) {
            const how = f.via.includes('shared') && f.via.includes('workspace')
              ? 'shared with you, and via a workspace'
              : f.via.includes('workspace') ? 'via a workspace' : 'shared with you'
            suffix += `  [${how} · requires @model]`
          }
          if (f.published) suffix += '  [public · requires @model]'
          if (f.read_only) suffix += '  [read only]'
          // The help promises the specialty beside the name.
          const spec = f.specialty ? `  (${f.specialty})` : ''
          this.log(`${handle(f).padEnd(handleWidth)}  ${f.name.padEnd(nameWidth)}${spec}${suffix}`.trimEnd())
        }
      }

      // Say when the list is short. A truncated list that reads as complete is
      // the reason this is followed page by page at all.
      if (truncated) {
        this.log('')
        this.log('This list is incomplete: the server had more faces than could be read in one go.')
      }
    }

    return data
  }
}
