import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {flattenAttributes, seg} from '../../utils.js'

interface BackupFace {
  alias: string
  name: string
  description: string | null
  basic_facts: Record<string, string> | null
  default_model: string | null
  default_tools: string[]
  formula: string | null
  tags: string[]
  documents: Array<{label: string | null; content: string; perspective: string | null; medium: string | null}>
  threads: Array<{
    label: string | null
    messages: Array<{role: string; content: string; name?: string}>
    // Absent from older backups.
    medium?: string | null
    source?: string | null
    /** A style corpus thread: material for a style build, not a thread to compile. */
    corpus?: boolean
  }>
  specialty?: string | null
  profile_addendum?: string | null
}

interface BackupGroup {
  name: string
  description: string | null
  protocol: string | null
  tags: string[]
  members: string[]  // face aliases
}

interface BackupFile {
  version: 2
  created_at: string
  faces: BackupFace[]
  groups: BackupGroup[]
}

export default class CatalogBackup extends BaseCommand {
  static description = 'Snapshot all faces, groups, and source material for migration'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CatalogBackup)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    // Fetch all faces with tags included
    let faces: Array<Record<string, unknown>>
    try {
      // Every page. A backup missing the faces past page one is the worst kind
      // of partial success: it reports fine and restores short.
      const all = await client.getAll('/v1/faces?include=tags,profile')
      faces = all.data
      if (all.truncated) {
        this.error('The face list was cut short, so this backup would be incomplete. Nothing was written.')
      }
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!json) process.stderr.write(`Found ${faces.length} face(s)\n`)

    const backupFaces: BackupFace[] = []

    for (const face of faces) {
      const alias = face.alias as string
      if (!json) process.stderr.write(`  ${alias}: `)

      // Tags and description come from the enriched list response
      const tags = (face.tags as string[]) ?? []

      const entry: BackupFace = {
        alias,
        name: face.name as string,
        description: (face.description as string) ?? null,
        basic_facts: face.basic_facts ? flattenAttributes(face.basic_facts as Record<string, unknown>) : null,
        default_model: (face.default_model as string) ?? null,
        default_tools: (face.default_tools as string[]) ?? [],
        formula: (face.formula as string) ?? null,
        tags,
        documents: [],
        threads: [],
      }

      // The listing leaves these out; a restored face lost them both.
      try {
        const full = await client.get(`/v1/faces/${seg(alias)}?include=profile`) as Record<string, unknown>
        entry.specialty = (full.specialty as string) ?? null
        entry.profile_addendum = (full.profile_addendum as string) ?? null
      } catch { /* keep what the listing gave */ }

      // Fetch documents
      try {
        const docs = await client.get('/v1/compile/documents', {params: {alias}}) as Array<Record<string, unknown>>
        for (const doc of docs) {
          entry.documents.push({
            label: (doc.label as string) ?? null,
            content: doc.content as string,
            perspective: (doc.perspective as string) ?? null,
            medium: (doc.medium as string) ?? null,
          })
        }
      } catch { /* face may have no documents */ }

      // Fetch threads
      try {
        // include_uploads: uploaded threads and corpus rooms are left out by
        // default, and a backup without them restores less than was there.
        const threads = await client.get('/v1/compile/threads', {params: {alias, include_uploads: 'true'}}) as Array<Record<string, unknown>>
        for (const thread of threads) {
          const threadId = thread.thread_id as string
          try {
            const full = await client.get(`/v1/compile/threads/${seg(threadId)}`) as Record<string, unknown>
            const messages = (full.messages as Array<{role: string; content: string; name?: string}>) ?? []
            entry.threads.push({
              label: (thread.label as string) ?? null,
              messages,
              medium: (thread.medium as string) ?? null,
              source: (thread.source as string) ?? null,
              corpus: Boolean(thread.corpus_medium) || thread.read_only === true,
            })
          } catch { /* skip threads we can't fetch */ }
        }
      } catch { /* face may have no threads */ }

      if (!json) process.stderr.write(`${entry.documents.length} doc(s), ${entry.threads.length} thread(s), ${tags.length} tag(s)\n`)
      backupFaces.push(entry)
    }

    // Fetch groups
    const backupGroups: BackupGroup[] = []
    // What could not be captured, so the summary can say so. A backup that
    // quietly holds no groups restores an account without its groups and reports
    // success either way.
    const gaps: string[] = []

    try {
      const resp = await client.get('/v1/me/groups') as {data?: Array<Record<string, unknown>>}
      let groups = resp.data ?? (resp as unknown as Array<Record<string, unknown>>)
      groups = groups.filter(t => t.kind !== 'personal')

      for (const group of groups) {
        const groupId = group.id as string
        if (!json) process.stderr.write(`  group ${group.name}: `)

        // Fetch members
        let memberAliases: string[] = []
        try {
          const membersResp = await client.get(`/v1/groups/${seg(groupId)}/members`) as {data?: Array<Record<string, unknown>>}
          const members = membersResp.data ?? []
          // Build uid→alias map from original face list
          const uidToAlias = new Map<string, string>()
          for (const f of faces) {
            if (f.uid) uidToAlias.set(f.uid as string, f.alias as string)
          }

          for (const m of members) {
            const iamId = m.iam_id as string
            const alias = uidToAlias.get(iamId) ?? iamId
            memberAliases.push(alias)
          }
        } catch {
          gaps.push(`members of group ${group.name as string}`)
        }

        // Fetch tags
        let groupTags: string[] = []
        try {
          const tagResp = await client.get(`/v1/groups/${seg(groupId)}/tags`) as {tags: string[]}
          groupTags = tagResp.tags ?? []
        } catch {
          gaps.push(`tags of group ${group.name as string}`)
        }

        backupGroups.push({
          name: group.name as string,
          description: (group.description as string) ?? null,
          protocol: (group.protocol as string) ?? null,
          tags: groupTags,
          members: memberAliases,
        })

        if (!json) process.stderr.write(`${memberAliases.length} member(s), ${groupTags.length} tag(s)\n`)
      }
    } catch {
      gaps.push('groups')
    }

    const backup: BackupFile = {
      version: 2,
      created_at: new Date().toISOString(),
      faces: backupFaces,
      groups: backupGroups,
    }

    const backupDir = path.join(os.homedir(), '.faces', 'backups')
    fs.mkdirSync(backupDir, {recursive: true})
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(backupDir, `${timestamp}.json`)
    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2))

    const totalDocs = backupFaces.reduce((n, f) => n + f.documents.length, 0)
    const totalThreads = backupFaces.reduce((n, f) => n + f.threads.length, 0)

    if (!json) {
      this.log(`\nBackup saved: ${filePath}`)
      this.log(`  ${backupFaces.length} face(s), ${totalDocs} document(s), ${totalThreads} thread(s), ${backupGroups.length} group(s)`)
      if (gaps.length > 0) {
        this.log(`  Not captured: ${gaps.join(', ')}. Restoring from this file will not bring them back.`)
      }
    }

    return {
      path: filePath,
      faces: backupFaces.length,
      documents: totalDocs,
      threads: totalThreads,
      groups: backupGroups.length,
      ...(gaps.length > 0 ? {not_captured: gaps} : {}),
    }
  }
}
