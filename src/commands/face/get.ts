import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {resolveBaseUrl} from '../../config.js'
import {FacesAPIError} from '../../client.js'
import {score10} from '../../fidelity.js'
import {faceStyles, renameFaceFields, resolveFace, isMeAlias, ME_MISSING, seg} from '../../utils.js'

interface FaceObject {
  alias: string
  uid: string
  name: string
  description?: string | null
  owned_by: string
  created: number
  formula?: string | null
  basic_facts?: Record<string, unknown> | null
  default_tools?: string[] | null
  default_model?: string | null
  profile_addendum?: string | null
  /** The media the face has a built style for; empty when none. */
  styles?: string[] | null
  read_only?: boolean
  /** The short line saying what this face is for. */
  specialty?: string | null
  /** Last change to the face itself, not to its compiled material. */
  updated_at?: string | null
  /** The latest fidelity score out of 10, its owner only. A new run replaces it. */
  fidelity?: number | null
  fidelity_at?: string | null
  fidelity_competitor?: string | null
  /** Counters, present only when asked for with --include usage. */
  usage?: Record<string, number> | null
}

export default class FaceGet extends BaseCommand {
  static description =
    'Get details for a face, by alias or owner:alias. A published or shared face is reachable under the ' +
    'same owner:alias address chat uses; it is shown with a note that you do not own it.'

  static flags = {
    ...BaseCommand.baseFlags,
    include: Flags.string({
      description:
        'Extra fields, comma-separated: tags, groups, profile, sharing, avatar, usage. `usage` adds the ' +
        '30-day counters; `avatar` says whether the picture is current or stale.',
    }),
    full: Flags.boolean({description: 'Print the full profile_addendum instead of a truncated preview'}),
  }

  static args = {
    face_id: Args.string({
      description: 'Face alias, or owner:alias for a face published by or shared from another account',
      required: true,
    }),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceGet)
    const client = this.makeClient(flags)

    // Always include profile; merge with user's --include
    const includes = new Set(['profile', 'tags'])
    if (flags.include) {
      // An unknown value was dropped without a word, so a typo looked like a
      // face with nothing to show.
      const known = ['tags', 'groups', 'profile', 'sharing', 'avatar', 'usage']
      for (const v of flags.include.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!known.includes(v)) this.error(`--include takes ${known.join(', ')} (got "${v}").`)
        includes.add(v)
      }
    }

    let resolved
    try {
      resolved = await resolveFace(client, args.face_id, [...includes].join(','))
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) {
          // A qualified name is looked up through the listing, which is the only
          // route that serves other people's faces. The listing can lag the
          // resolver, so a miss is not proof of absence and
          // must not be reported as one.
          if (args.face_id.includes(':')) {
            this.error(
              `Could not find '${args.face_id}' in the face listing.\n` +
                'A published face can be reachable before it appears there, so this may not mean it does ' +
                `not exist. If you know the handle, try it directly: faces chat:chat ${args.face_id}@<model>`,
            )
          }
          if (isMeAlias(args.face_id)) this.error(ME_MISSING)
          this.error(
            `No face '${args.face_id}'. If it belongs to another account, name it as owner:alias, ` +
              'the same address chat uses. Find it with: faces face:list --public',
          )
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    const data = resolved.face
    // Some other server can answer 200 with JSON of its own.
    if (typeof (data as Record<string, unknown>).alias !== 'string') {
      this.error(`${resolveBaseUrl(flags['base-url'])} did not answer like the Faces API: the face has no alias. Check the base URL in: faces config:show`)
    }
    const face = data as Record<string, unknown>
    renameFaceFields(face)
    const f = face as unknown as FaceObject & {attributes?: Record<string, unknown>}

    if (!this.jsonEnabled()) {
      this.log(`alias:     ${f.alias}`)
      this.log(`uid:       ${f.uid}`)
      this.log(`name:      ${f.name}`)
      if (f.specialty) this.log(`specialty: ${f.specialty}`)
      // Only --json had it, so editing a face showed a view without the edit.
      if (f.description) this.log(`description: ${f.description}`)
      this.log(`owned_by:  ${f.owned_by}`)
      // Say plainly that this is someone else's, and how it can be used.
      if (!resolved.owned) {
        this.log(`access:    not yours; reachable because it is published or shared with you`)
        this.log(`address:   ${resolved.handle}@<model>  (chat, or a group member; only its owner can edit it)`)
      }
      if (typeof f.created === 'number') this.log(`created:   ${new Date(f.created * 1000).toISOString().slice(0, 10)}`)
      // When the face itself last changed. Its compiled material moves on its
      // own schedule, which face:sources reports.
      if (f.updated_at) this.log(`updated:   ${f.updated_at.slice(0, 10)}`)
      // The media it has a built style for, which are what --style may ask
      // for. Asking for one not listed is refused rather than quietly answered
      // in the ordinary voice.
      const media = faceStyles(f)
      if (media.length > 0) this.log(`styles:    ${media.join(', ')}  (ask for one with --style)`)
      if (typeof f.fidelity === 'number') {
        const against = f.fidelity_competitor ? ` against ${f.fidelity_competitor}` : ''
        const when = f.fidelity_at ? `, ${f.fidelity_at.slice(0, 10)}` : ''
        this.log(`fidelity:  ${score10(f.fidelity)} out of 10${against}${when}`)
      }
      // Counters only arrive when asked for, so their absence says nothing.
      if (f.usage && Object.keys(f.usage).length > 0) {
        const u = f.usage
        const parts: string[] = []
        if (u.users_30d !== undefined) parts.push(`${u.users_30d} user(s) in 30d`)
        if (u.tokens_30d !== undefined) parts.push(`${u.tokens_30d.toLocaleString()} tokens in 30d`)
        if (u.tokens_total !== undefined) parts.push(`${u.tokens_total.toLocaleString()} tokens all told`)
        this.log(`usage:     ${parts.length > 0 ? parts.join(', ') : JSON.stringify(u)}`)
      }

      // The face route can answer tags: null while the tags route has them.
      let tags = (data as {tags?: string[] | null}).tags
      if (!tags && resolved.owned) {
        try {
          tags = ((await client.get(`/v1/iam/${seg(String(f.alias))}/tags`)) as {tags?: string[]}).tags ?? null
        } catch { /* leave them out */ }
      }
      if (tags && tags.length > 0) this.log(`tags:      ${tags.join(', ')}`)
      if (f.read_only) this.log('read only')
      if (f.formula) {
        this.log(`formula:   ${f.formula}`)
        this.log(`type:      composite`)
      } else {
        this.log(`type:      concrete`)
        if (f.attributes && Object.keys(f.attributes).length > 0) {
          this.log('attributes:')
          for (const [k, v] of Object.entries(f.attributes)) {
            this.log(`  ${k}: ${v}`)
          }
        }
        if (f.default_tools && f.default_tools.length > 0) this.log(`default_tools: ${f.default_tools.join(', ')}`)
        if (f.default_model) this.log(`default_model: ${f.default_model}`)
      }
      if (f.profile_addendum) {
        const text = f.profile_addendum
        if (flags.full) {
          this.log(`profile_addendum (${text.length} chars):`)
          this.log(text)
        } else {
          const oneLine = text.replace(/\s+/g, ' ').trim()
          const preview = oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine
          this.log(`profile_addendum (${text.length} chars): ${preview}`)
          if (oneLine.length > 160) this.log('  (use --full to print the whole prompt)')
        }
      }
    }

    return data
  }
}
