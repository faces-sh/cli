import fs from 'node:fs'
import path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {loadConfig} from '../../config.js'
import {unquoteYaml, seg} from '../../utils.js'
import {CatalogService, CATALOG_DIR, type FaceFrontmatter, type FaceDataInput} from '../../catalog.js'
import {GroupCatalogService, GROUPS_DIR, slugifyGroupName} from '../../group-catalog.js'

interface FaceObject extends FaceDataInput {
  uid: string
}

export default class CatalogDoctor extends BaseCommand {
  static description =
    'Diagnose and repair the local face and group catalog.'

  static flags = {
    ...BaseCommand.baseFlags,
    fix: Flags.boolean({description: 'Rebuild missing or stale catalog entries from API', default: false}),
    generate: Flags.boolean({
      description: 'Retired: descriptions were written by chatting with each face, and chat is retired. Write one with faces face:edit <alias> --description.',
      default: false,
      hidden: true,
    }),
    'allow-paid': Flags.boolean({description: 'Retired with --generate.', default: false, hidden: true}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CatalogDoctor)
    // Refuse before any request, so nobody is charged who did not mean to be.
    if (flags.generate) {
      this.error(
        '--generate wrote descriptions by chatting with each face, and chat is retired. Nothing was sent.\n' +
          'Write a description with: faces face:edit <alias> --description "..."\n' +
          'To repair the catalog, which is free: faces catalog:doctor --fix',
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
