import fs from 'node:fs'
import path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {loadConfig} from '../../config.js'
import {unquoteYaml, seg, postChat} from '../../utils.js'
import {CatalogService, CATALOG_DIR, type FaceFrontmatter, type FaceDataInput} from '../../catalog.js'
import {GroupCatalogService, GROUPS_DIR, slugifyGroupName} from '../../group-catalog.js'
import {resolveEndpoint, MESSAGES_ENDPOINT, RESPONSES_ENDPOINT} from '../../routing.js'

interface FaceObject extends FaceDataInput {
  uid: string
}

export default class CatalogDoctor extends BaseCommand {
  static description =
    'Diagnose and repair the local face and group catalog. --generate bills, so it needs --allow-paid.'

  static flags = {
    ...BaseCommand.baseFlags,
    fix: Flags.boolean({description: 'Rebuild missing or stale catalog entries from API', default: false}),
    generate: Flags.boolean({
      description:
        'Fix, then write a description for each face that has none by asking the face. This bills: each one ' +
        'is a chat on gpt-5-nano (or the catalog_model you set), charged to credits. Needs --allow-paid.',
      default: false,
    }),
    'allow-paid': Flags.boolean({
      description:
        'Permit the charge for --generate. Without this flag --generate sends nothing and nothing is charged.',
      default: false,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CatalogDoctor)
    // Refuse before any request, so nobody is charged who did not mean to be.
    if (flags.generate && !flags['allow-paid']) {
      this.error(
        'Generating descriptions bills your account: each one is a chat with the face, charged to credits. ' +
          'Re-run with --allow-paid if you meant to pay.\n' +
          'To repair the catalog without generating anything, which is free: faces catalog:doctor --fix',
      )
    }

    const client = this.makeClient(flags)
    const catalog = new CatalogService()
    const groupCatalog = new GroupCatalogService()

    // Fetch all faces from API (with tags)
    let remoteFaces: FaceObject[]
    try {
      // Every page: doctor compares remote against local and reports what is
      // missing, so a short remote list would invent orphans that are not.
      const all = await client.getAll('/v1/faces?include=tags,profile')
      if (all.truncated) {
        this.error('The face list was cut short, so a comparison against the catalog would be wrong.')
      }

      const arr = all.data as unknown as FaceObject[]
      // Fetch full details for each face (tags come from list, but need description etc.)
      remoteFaces = await Promise.all(
        arr.map(async (f) => {
          try {
            const full = await client.get(`/v1/faces/${seg(f.alias)}?include=tags,profile`) as FaceObject
            return full
          } catch {
            return {...f, uid: f.alias} as FaceObject
          }
        }),
      )
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // Build map of remote faces by alias
    const remoteByAlias = new Map<string, FaceObject>()
    for (const f of remoteFaces) {
      remoteByAlias.set(f.alias, f)
    }

    // Read local catalog
    const localAliases = new Set<string>()
    const localFrontmatters = new Map<string, FaceFrontmatter>()
    try {
      if (fs.existsSync(CATALOG_DIR)) {
        for (const dirent of fs.readdirSync(CATALOG_DIR, {withFileTypes: true})) {
          if (!dirent.isDirectory()) continue
          localAliases.add(dirent.name)
          const faceMdPath = path.join(CATALOG_DIR, dirent.name, 'FACE.md')
          if (fs.existsSync(faceMdPath)) {
            const content = fs.readFileSync(faceMdPath, 'utf8')
            const match = content.match(/^---\n([\s\S]*?)\n---/)
            if (match) {
              const fm: Partial<FaceFrontmatter> = {alias: dirent.name}
              for (const line of match[1].split('\n')) {
                if (line.startsWith('  ')) continue
                const ci = line.indexOf(':')
                if (ci < 0) continue
                const k = line.slice(0, ci).trim()
                const v = unquoteYaml(line.slice(ci + 1))
                if (k === 'name') fm.name = v
                if (k === 'description') fm.description = v
              }
              if (fm.name) localFrontmatters.set(dirent.name, fm as FaceFrontmatter)
            }
          }
        }
      }
    } catch { /* continue with what we have */ }

    // Compute face diffs
    const missing: FaceObject[] = []
    const stale: FaceObject[] = []
    const noDescription: string[] = []
    const orphaned: string[] = []

    for (const [alias, remote] of remoteByAlias) {
      if (!localAliases.has(alias)) {
        missing.push(remote)
      } else {
        const local = localFrontmatters.get(alias)
        if (local && local.name !== remote.name) {
          stale.push(remote)
        }
      }
      const local = localFrontmatters.get(alias)
      if (!local?.description) noDescription.push(alias)
    }

    for (const alias of localAliases) {
      if (!remoteByAlias.has(alias)) orphaned.push(alias)
    }

    // Check groups
    let remoteGroups: Array<Record<string, unknown>> = []
    // Every group the account has, personal included. The sync pass skips the
    // personal Guild, but orphan detection must not: a local copy of a group
    // that was filtered out of the comparison looks deleted when it is not.
    let allRemoteSlugs = new Set<string>()
    // Whether the server actually answered. Without this an unreachable API
    // looks exactly like an account with no groups, and --fix would delete the
    // entire local group catalog on a timeout.
    let groupsFetched = false
    const localGroupNames = new Set(groupCatalog.listGroups())
    try {
      const resp = await client.get('/v1/me/groups') as {data?: Array<Record<string, unknown>>}
      const all = resp.data ?? (resp as unknown as Array<Record<string, unknown>>)
      allRemoteSlugs = new Set(all.map(t => slugifyGroupName(String(t.name))))
      remoteGroups = all.filter(t => t.kind !== 'personal')
      groupsFetched = true
    } catch { /* proceed; groupsFetched stays false */ }

    const missingGroups = remoteGroups.filter(t => !localGroupNames.has(slugifyGroupName(String(t.name))))

    // The mirror of the orphaned-face pass: present locally, gone from the server.
    const orphanedGroups = groupsFetched
      ? [...localGroupNames].filter(name => !allRemoteSlugs.has(name))
      : []
    // A deleted group's protocol survives only in TEAM.md, so anything with a
    // body is reported rather than removed. Frontmatter alone is reproducible
    // and safe to drop.
    const removableGroups = orphanedGroups.filter(name => !groupCatalog.hasLocalContent(name))
    const keptGroups = orphanedGroups.filter(name => groupCatalog.hasLocalContent(name))

    const doFix = flags.fix || flags.generate

    if (!doFix) {
      const issues: string[] = []
      if (missing.length > 0) issues.push(`${missing.length} face(s) missing from catalog`)
      if (stale.length > 0) issues.push(`${stale.length} face(s) out of sync`)
      if (orphaned.length > 0) issues.push(`${orphaned.length} orphaned catalog entries (face deleted on server)`)
      if (noDescription.length > 0) issues.push(`${noDescription.length} face(s) without a description`)
      if (missingGroups.length > 0) issues.push(`${missingGroups.length} group(s) missing from local catalog`)
      if (removableGroups.length > 0) issues.push(`${removableGroups.length} local group(s) no longer on the server`)
      if (keptGroups.length > 0) {
        issues.push(
          `${keptGroups.length} local group(s) no longer on the server with local content: ${keptGroups.join(', ')}`,
        )
      }

      if (issues.length === 0) {
        this.log('Catalog is healthy.')
      } else {
        for (const issue of issues) this.log(issue)
        this.log('')
        this.log('Run faces catalog:doctor --fix to repair catalog')
        if (noDescription.length > 0) {
          this.log('Run faces catalog:doctor --generate --allow-paid to also write missing descriptions (billed)')
        }
      }

      return {
        missing: missing.length,
        stale: stale.length,
        orphaned: orphaned.length,
        noDescription: noDescription.length,
        missingGroups: missingGroups.length,
        orphanedGroups: removableGroups.length,
        orphanedGroupsKept: keptGroups,
      }
    }

    // Fix mode: rebuild face entries
    let fixed = 0
    for (const face of [...missing, ...stale]) {
      catalog.writeFace(face)
      fixed++
    }

    // Refresh all existing faces (attributes, tags, description)
    for (const [alias, remote] of remoteByAlias) {
      if (!missing.some((f) => f.alias === alias) && !stale.some((f) => f.alias === alias)) {
        catalog.writeFace(remote)
      }
    }

    // Remove orphaned faces
    let removed = 0
    for (const alias of orphaned) {
      catalog.deleteFace(alias)
      removed++
    }

    // Sync groups
    let groupsSynced = 0
    // Build uid→alias map for member resolution
    const uidToAlias = new Map<string, string>()
    for (const f of remoteFaces) {
      if (f.uid) uidToAlias.set(f.uid, f.alias)
    }

    for (const group of remoteGroups) {
      const groupId = group.id as string
      const slug = slugifyGroupName(String(group.name))

      // Fetch members and tags
      let memberAliases: string[] = []
      try {
        const membersResp = await client.get(`/v1/groups/${seg(groupId)}/members`) as {data?: Array<Record<string, unknown>>}
        memberAliases = (membersResp.data ?? []).map(m => {
          const iamId = m.iam_id as string
          return uidToAlias.get(iamId) ?? iamId
        })
      } catch { /* proceed */ }

      let tags: string[] = []
      try {
        const tagResp = await client.get(`/v1/groups/${seg(groupId)}/tags`) as {tags?: string[]}
        tags = tagResp.tags ?? []
      } catch { /* proceed */ }

      groupCatalog.writeGroup(slug, {
        id: groupId,
        name: group.name as string,
        description: (group.description as string) ?? undefined,
        tags,
        members: memberAliases,
      }, (group.protocol as string) ?? undefined)
      groupsSynced++
    }

    // Remove orphaned groups, the mirror of the orphaned-face removal above.
    let groupsRemoved = 0
    for (const name of removableGroups) {
      groupCatalog.deleteGroup(name)
      groupsRemoved++
    }

    this.log(
      `Fixed ${fixed} face(s), removed ${removed} orphaned face(s) and ${groupsRemoved} orphaned group(s), ` +
        `synced ${groupsSynced} group(s).`,
    )
    // Never let a partial clean-up read as a complete one.
    for (const name of keptGroups) {
      this.log(
        `Kept '${name}': the group is gone from the server but TEAM.md has content that exists nowhere else. ` +
          `Remove it yourself with: rm -rf ${path.join(GROUPS_DIR, name)}`,
      )
    }
    if (!groupsFetched) {
      this.log('Could not reach the groups API, so local groups were not checked against the server.')
    }

    // Generate mode: create missing descriptions
    if (flags.generate && noDescription.length > 0) {
      const cfg = loadConfig()
      const catalogModel = cfg.catalog_model ?? 'gpt-5-nano'

      this.log(`Generating descriptions for ${noDescription.length} face(s) via ${catalogModel}...`)

      // Route the description LLM the same way chat does: off the catalog.
      const {endpoint: descEndpoint} = await resolveEndpoint(client, `_@${catalogModel}`)

      let generated = 0
      for (const alias of noDescription) {
        const remote = remoteByAlias.get(alias)
        if (!remote) continue

        try {
          const prompt = 'Describe yourself in one paragraph. Who are you, what do you care about, and what kind of questions are you best suited to answer?'
          const faceModel = `${alias}@${catalogModel}`

          let text: string | undefined
          if (descEndpoint === MESSAGES_ENDPOINT) {
            const resp = (await postChat(client, '/v1/messages', {model: faceModel, messages: [{role: 'user', content: prompt}], max_tokens: 256})).data as {content?: Array<{type: string; text: string}>}
            text = resp.content?.find((b) => b.type === 'text')?.text
          } else if (descEndpoint === RESPONSES_ENDPOINT) {
            const resp = (await postChat(client, '/v1/responses', {model: faceModel, input: [{role: 'user', content: prompt}], max_output_tokens: 256})).data as {output?: Array<{content?: Array<{type: string; text: string}>}>}
            let out = ''
            for (const item of resp.output ?? []) {
              for (const block of item.content ?? []) {
                if (block.type === 'output_text') out += block.text ?? ''
              }
            }
            text = out || undefined
          } else {
            const resp = (await postChat(client, '/v1/chat/completions', {model: faceModel, messages: [{role: 'user', content: prompt}], max_tokens: 256})).data as {choices?: Array<{message: {content: string}}>}
            text = resp.choices?.[0]?.message?.content
          }
          if (text) {
            const desc = text.trim()
            catalog.writeFace({...remote, description: desc})
            try {
              await client.patch(`/v1/faces/${seg(alias)}`, {body: {description: desc}})
            } catch { /* non-fatal */ }
            generated++
            this.log(`  ${alias}: done`)
          } else {
            this.log(`  ${alias}: no response`)
          }
        } catch (err) {
          const msg = err instanceof FacesAPIError ? `HTTP ${err.statusCode}: ${err.message}` : String(err)
          this.log(`  ${alias}: failed: ${msg}`)
        }
      }

      this.log(`Generated ${generated} description(s).`)
    }

    catalog.rebuildIndex()
    return {
      fixed,
      removed,
      groupsRemoved,
      groupsKept: keptGroups,
      groupsSynced,
      generated: flags.generate ? noDescription.length : 0,
    }
  }
}
