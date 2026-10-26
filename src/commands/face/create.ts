import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {CatalogService} from '../../catalog.js'
import {renameFaceFields, resolveProfileAddendum, seg, badFaceName, badToolNames, compact} from '../../utils.js'

export default class FaceCreate extends BaseCommand {
  static description = 'Create a new face'

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Display name', required: true}),
    alias: Flags.string({description: 'Unique alias slug', required: true}),
    description: Flags.string({description: 'Plain-text description / bio (max 1500 chars)'}),
    specialty: Flags.string({
      description:
        'A short line saying what this face is for, shown beside its name in listings and on its card ' +
        '(for example "tax law", or "my own voice")',
    }),
    tag: Flags.string({description: 'Tag label (repeatable, lowercase)', multiple: true}),
    'default-model': Flags.string({description: 'Default LLM for chat (e.g. gpt-4o-mini, claude-sonnet-4-6)'}),
    formula: Flags.string({description: 'Boolean formula over owned concrete face aliases (e.g. "a | b", "(a | b) - c"). Creates a composite face.'}),
    attr: Flags.string({
      description:
        'Set attribute KEY=VALUE (repeatable). age, gender and location take a bare value ("45", "Lisbon, ' +
        'Portugal"); identity, education, occupation, religion, family, relationships, health, languages and ' +
        'background take a short sentence. Any other key is refused, and then nothing is saved. See faces face:attributes.',
      multiple: true,
    }),
    tool: Flags.string({description: 'Tool name to enable (repeatable). The server stores any name without checking it, so spell it as the tool expects.', multiple: true}),
    'profile-addendum': Flags.string({description: 'A saved system prompt fragment, sent to the model on each chat request with this face (max 100,000 chars). Anyone who can chat with the face may be able to get the model to repeat it.'}),
    'profile-addendum-file': Flags.string({description: 'Read the per-face system prompt from a file (alternative to --profile-addendum). Anyone who can chat with the face may be able to get the model to repeat it.', exclusive: ['profile-addendum']}),
  }

  static args = {}

  async run(): Promise<unknown> {
    const {flags} = await this.parse(FaceCreate)
    const client = this.makeClient(flags)

    if (flags.formula && (flags.attr?.length || flags.tool?.length)) {
      this.error('--formula cannot be combined with --attr or --tool. A composite face has nothing compiled of its own.')
    }

    const nameProblem = badFaceName(flags.name)
    if (nameProblem) this.error(`--name: ${nameProblem}`)
    const payload: Record<string, unknown> = {name: flags.name, alias: flags.alias}
    if (flags.description) payload.description = flags.description
    if (flags.specialty !== undefined) payload.specialty = flags.specialty

    let addendum: string | undefined
    try {
      addendum = resolveProfileAddendum(flags['profile-addendum'], flags['profile-addendum-file'])
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    if (addendum !== undefined) payload.profile_addendum = addendum

    if (flags.formula) {
      payload.formula = flags.formula
      if (flags['default-model']) payload.default_model = flags['default-model']
    } else {
      const parsedAttrs: Record<string, string> = {}
      for (const a of flags.attr ?? []) {
        if (!a.includes('=') || !a.slice(0, a.indexOf('=')).trim()) this.error(`Attributes must be KEY=VALUE, got: ${a}. See the keys with: faces face:attributes`)
        const idx = a.indexOf('=')
        parsedAttrs[a.slice(0, idx).trim()] = a.slice(idx + 1).trim()
      }
      if (Object.keys(parsedAttrs).length > 0) payload.basic_facts = parsedAttrs
      if (flags.tool && flags.tool.length > 0) {
        const toolProblem = badToolNames(flags.tool)
        if (toolProblem) this.error(`--tool: ${toolProblem}`)
        payload.default_tools = flags.tool.map((t) => t.trim())
      }
      if (flags['default-model']) payload.default_model = flags['default-model']
    }

    let data: unknown
    try {
      data = await client.post('/v1/faces', {body: payload})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    const face = data as Record<string, unknown>
    if (Array.isArray(face.warnings) && face.warnings.length > 0) {
      for (const w of face.warnings) this.warn(w as string)
    }

    // Post tags if provided
    const tags = flags.tag ?? []
    if (tags.length > 0) {
      try {
        await client.post(`/v1/iam/${seg(flags.alias)}/tags`, {body: {tags}})
        face.tags = tags
      } catch (err) {
        // The rest saved, but a request that half failed must not exit 0.
        if (err instanceof FacesAPIError) {
          this.warn(`Tags failed (${err.statusCode}): ${err.message}`)
          process.exitCode = 1
        }
      }
    }

    // Rename basic_facts → attributes in response
    renameFaceFields(face)

    // Write to local catalog with tags
    try {
      const catalog = new CatalogService()
      catalog.writeFace({
        ...face as {alias: string; name: string},
        basic_facts: face.attributes as Record<string, string> | null,
        tags: (face.tags as string[]) ?? undefined,
        description: (face.description as string) ?? flags.description ?? undefined,
        default_model: face.default_model as string | undefined,
        formula: face.formula as string | undefined,
      } as any)
    } catch { /* catalog errors are non-fatal */ }

    // About thirty fields are null on a new or edited face; print what is set.
    if (!this.jsonEnabled()) this.printHuman(compact(data))
    return data
  }
}
