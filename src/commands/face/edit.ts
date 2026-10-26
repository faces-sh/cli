import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CatalogService} from '../../catalog.js'
import {renameFaceFields, resolveProfileAddendum, seg, isMeAlias, ME_MISSING, badFaceName, badToolNames, compact} from '../../utils.js'

export default class FaceEdit extends BaseCommand {
  static description = "Edit a face's metadata"

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'New display name'}),
    description: Flags.string({description: 'Plain-text description / bio (max 1500 chars)'}),
    specialty: Flags.string({
      description:
        'Replace the short line saying what this face is for. Pass an empty string to remove it.',
    }),
    tag: Flags.string({description: 'Replace all tags (repeatable, lowercase)', multiple: true}),
    'default-model': Flags.string({description: 'Default LLM for chat (e.g. gpt-4o-mini, claude-sonnet-4-6)'}),
    formula: Flags.string({
      description:
        'New formula, making the face a composite. Pass an empty string to turn a composite back into an ordinary ' +
        'face. Refused on a face with compiled sources of its own, or one used in another composite: make a new ' +
        'composite with faces face:create --formula instead.',
    }),
    attr: Flags.string({
      description:
        'Update attribute KEY=VALUE (repeatable). age, gender and location take a bare value ("45", "Lisbon, ' +
        'Portugal"); identity, education, occupation, religion, family, relationships, health, languages and ' +
        'background take a short sentence. Any other key is refused, and then nothing is saved. See faces face:attributes.',
      multiple: true,
    }),
    tool: Flags.string({description: 'Tool names to set (replaces list, repeatable). The server stores any name without checking it, so spell it as the tool expects.', multiple: true}),
    'profile-addendum': Flags.string({description: 'Replace the per-face system prompt (max 100,000 chars). Anyone who can chat with the face may be able to get the model to repeat it.'}),
    'profile-addendum-file': Flags.string({description: 'Replace the per-face system prompt from a file. Anyone who can chat with the face may be able to get the model to repeat it.', exclusive: ['profile-addendum']}),
    'clear-profile-addendum': Flags.boolean({description: 'Remove the per-face system prompt.', exclusive: ['profile-addendum', 'profile-addendum-file']}),
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceEdit)
    const client = this.makeClient(flags)

    const payload: Record<string, unknown> = {}
    if (flags.name !== undefined) {
      const nameProblem = badFaceName(flags.name)
      if (nameProblem) this.error(`--name: ${nameProblem}`)
      payload.name = flags.name
    }
    // The server refuses a formula that would bury compiled sources or break
    // another composite (409), and an empty one makes an ordinary face again.
    if (flags.formula !== undefined) payload.formula = flags.formula.trim()
    if (flags.attr && flags.attr.length > 0) {
      const parsed: Record<string, string> = {}
      for (const a of flags.attr) {
        if (!a.includes('=') || !a.slice(0, a.indexOf('=')).trim()) this.error(`Attributes must be KEY=VALUE, got: ${a}. See the keys with: faces face:attributes`)
        const idx = a.indexOf('=')
        parsed[a.slice(0, idx).trim()] = a.slice(idx + 1).trim()
      }

      payload.basic_facts = parsed
    }

    if (flags.tool && flags.tool.length > 0) {
      const toolProblem = badToolNames(flags.tool)
      if (toolProblem) this.error(`--tool: ${toolProblem}`)
      payload.default_tools = flags.tool.map((t) => t.trim())
    }
    if (flags['default-model']) payload.default_model = flags['default-model']
    if (flags.description !== undefined) payload.description = flags.description
    if (flags.specialty !== undefined) payload.specialty = flags.specialty

    if (flags['clear-profile-addendum']) {
      payload.profile_addendum = ''
    } else {
      let addendum: string | undefined
      try {
        addendum = resolveProfileAddendum(flags['profile-addendum'], flags['profile-addendum-file'])
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err))
      }
      if (addendum !== undefined) payload.profile_addendum = addendum
    }

    const hasTags = flags.tag && flags.tag.length > 0

    if (Object.keys(payload).length === 0 && !hasTags) this.error('Provide at least one field to update.')

    let data: unknown
    if (Object.keys(payload).length > 0) {
      try {
        data = await client.patch(`/v1/faces/${seg(args.face_id)}`, {body: payload})
      } catch (err) {
        if (err instanceof FacesAPIError && err.statusCode === 404) {
          this.error(isMeAlias(args.face_id) ? ME_MISSING : `No face '${args.face_id}' on this account. List yours with: faces face:list`)
        }
        if (err instanceof FacesAPIError && err.statusCode === 409 && payload.formula) {
          this.error(
            `HTTP 409: ${err.message}\n` +
              `Make a new composite instead: faces face:create --alias <new-alias> --name <name> --formula "${payload.formula}"`,
          )
        }
        if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
        throw err
      }
    } else {
      try {
        data = await client.get(`/v1/faces/${seg(args.face_id)}?include=profile`)
      } catch (err) {
        if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
        throw err
      }
    }

    // Replace tags if provided
    if (hasTags) {
      try {
        await client.put(`/v1/iam/${seg(args.face_id)}/tags`, {body: {tags: flags.tag}})
      } catch (err) {
        // The rest saved, but a request that half failed must not exit 0.
        if (err instanceof FacesAPIError) {
          this.warn(`Tags failed (${err.statusCode}): ${err.message}`)
          process.exitCode = 1
        }
      }
    }

    // Always fetch current tags so the catalog stays in sync
    let currentTags: string[] = []
    try {
      const tagResp = await client.get(`/v1/iam/${seg(args.face_id)}/tags`) as {tags?: string[]}
      currentTags = tagResp.tags ?? []
    } catch { /* proceed without tags */ }

    const face = data as Record<string, unknown>
    if (Array.isArray(face.warnings) && face.warnings.length > 0) {
      for (const w of face.warnings) this.warn(w as string)
    }

    face.tags = currentTags

    // Rename basic_facts → attributes
    renameFaceFields(face)

    // Write to local catalog
    try {
      const catalog = new CatalogService()
      catalog.writeFace({
        ...face as {alias: string; name: string},
        basic_facts: face.attributes as Record<string, string> | null,
        tags: (face.tags as string[]) ?? undefined,
        description: (face.description as string) ?? undefined,
        default_model: face.default_model as string | undefined,
        formula: face.formula as string | undefined,
      } as any)
    } catch { /* catalog errors are non-fatal */ }

    // About thirty fields are null on a new or edited face; print what is set.
    if (!this.jsonEnabled()) this.printHuman(compact(data))
    return data
  }
}
