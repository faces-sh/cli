import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError, FacesClient} from '../../client.js'
import {CatalogService} from '../../catalog.js'
import {seg} from '../../utils.js'

interface BackupFace {
  alias: string
  name: string
  description?: string | null
  basic_facts: Record<string, string> | null
  default_model: string | null
  default_tools: string[]
  formula: string | null
  tags?: string[]
  // medium is absent from older backups, and null for a document saved before one was required.
  documents: Array<{label: string | null; content: string; perspective: string | null; medium?: string | null}>
  threads: Array<{
    label: string | null
    messages: Array<{role: string; content: string; name?: string}>
    medium?: string | null
    source?: string | null
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
  members: string[]
}

interface BackupFile {
  version: 1 | 2
  created_at: string
  faces: BackupFace[]
  groups?: BackupGroup[]
  /** The same list, as backups written before the rename carry it. */
  teams?: BackupGroup[]
}

export default class CatalogRestore extends BaseCommand {
  static description = 'Restore faces, groups, and source material from a backup snapshot'

  static flags = {
    ...BaseCommand.baseFlags,
    compile: Flags.boolean({description: 'Run compile:all after restoring', default: false}),
  }

  static args = {
    file: Args.string({description: 'Backup file path (default: most recent in ~/.faces/backups/)'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CatalogRestore)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    const filePath = args.file ?? this.findLatestBackup()
    if (!fs.existsSync(filePath)) this.error(`Backup file not found: ${filePath}`)

    let backup: BackupFile
    try {
      backup = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BackupFile
    } catch {
      this.error(`${filePath} is not a backup file: it is not valid JSON. Make one with: faces catalog:backup`)
    }

    // "Unsupported backup version: undefined" said nothing about the file.
    if (!backup || typeof backup !== 'object' || !Array.isArray(backup.faces)) {
      this.error(`${filePath} is not a faces backup: it has no list of faces. Make one with: faces catalog:backup`)
    }
    if (!backup.groups && Array.isArray(backup.teams)) {
      backup.groups = backup.teams
    }
    if (backup.version !== 1 && backup.version !== 2) this.error(`Unsupported backup version: ${backup.version}`)

    if (!json) {
      this.log(`Restoring from: ${filePath}`)
      this.log(`  Created: ${backup.created_at}`)
      this.log(`  Faces: ${backup.faces.length}, Groups: ${backup.groups?.length ?? 0}\n`)
    }

    const catalog = new CatalogService()
    let facesCreated = 0
    let facesSkipped = 0
    let docsUploaded = 0
    let threadsUploaded = 0
    let groupsCreated = 0
    // Everything that did not come back, so the summary cannot read as a
    // complete restore when it is not one.
    const failures: string[] = []
    const skippedCorpus: string[] = []

    for (const face of backup.faces) {
      if (!json) process.stderr.write(`${face.alias}: `)

      const created = await this.createFace(client, face)
      if (!created) {
        facesSkipped++
        if (!json) process.stderr.write('exists, skipping\n')
        continue
      }

      facesCreated++

      // Post tags
      if (face.tags && face.tags.length > 0) {
        try {
          await client.post(`/v1/iam/${seg(face.alias)}/tags`, {body: {tags: face.tags}})
        } catch { /* non-fatal */ }
      }

      // Write to local catalog
      try {
        catalog.writeFace({alias: face.alias, name: face.name, basic_facts: face.basic_facts}, face.description ?? undefined)
      } catch { /* non-fatal */ }

      let docsHere = 0
      // Upload documents
      for (const doc of face.documents) {
        try {
          const payload: Record<string, unknown> = {alias: face.alias, content: doc.content}
          if (doc.label) payload.label = doc.label
          if (doc.perspective) payload.perspective = doc.perspective
          // The server will not save a document without a medium. One the
          // backup does not record is still sent, and the server says whether
          // it takes it; guessing one would mislabel the document with nothing
          // to say it happened.
          if (doc.medium) payload.medium = doc.medium
          await client.post('/v1/compile/documents', {body: payload})
          docsUploaded++
          docsHere++
        } catch (err) {
          const msg = err instanceof FacesAPIError ? `${err.statusCode}: ${err.message}` : String(err)
          const why = doc.medium ? '' : ` (the backup records no medium for "${doc.label ?? 'untitled'}"; ` +
            `create it with faces compile:doc:create ${face.alias} --medium <medium>)`
          failures.push(`${face.alias}: document "${doc.label ?? 'untitled'}" (${msg})${why}`)
          if (!json) process.stderr.write(`\n    warn: doc upload failed: ${msg}${why}\n    `)
        }
      }

      // Recreate threads. POST /v1/compile/threads starts an interview, which
      // is charged and refused on an empty balance; every thread was lost that
      // way while the summary still counted it. A transcript upload creates
      // the thread without one, and the backed-up messages then replace it
      // exactly, roles and names included.
      let threadsHere = 0
      for (const thread of face.threads) {
        const label = thread.label ?? 'untitled'
        if (thread.corpus) {
          // A style corpus restored as a thread would be compiled into the
          // face, the opposite of what it was.
          skippedCorpus.push(`${face.alias}: ${label}`)
          continue
        }

        if (thread.messages.length === 0) {
          failures.push(`${face.alias}: thread "${label}" has no messages in the backup`)
          continue
        }

        try {
          const transcript = thread.messages
            .map((m) => `${(m.name || m.role).replace(/:/g, ' ')}: ${m.content.replace(/\s+/g, ' ')}`)
            .join('\n')
          const speaker = thread.messages.find((m) => m.role === 'user')
          const params = new URLSearchParams({type: 'thread', perspective: 'first-person'})
          if (speaker) params.set('face_speaker', (speaker.name || speaker.role).replace(/:/g, ' '))
          const form = new FormData()
          form.append('file', new Blob([transcript], {type: 'text/plain'}), `${label}.txt`)
          const created = await client.postForm(`/v1/faces/${seg(face.alias)}/upload?${params}`, form) as Record<string, unknown>
          const threadId = created.thread_id as string
          await client.patch(`/v1/compile/threads/${seg(threadId)}/messages`, {body: {messages: thread.messages}})
          const meta: Record<string, unknown> = {label}
          if (thread.medium) meta.medium = thread.medium
          await client.patch(`/v1/compile/threads/${seg(threadId)}`, {body: meta})
          threadsUploaded++
          threadsHere++
        } catch (err) {
          const msg = err instanceof FacesAPIError ? `${err.statusCode}: ${err.message}` : String(err)
          failures.push(`${face.alias}: thread "${label}" (${msg})`)
          if (!json) process.stderr.write(`\n    warn: thread upload failed: ${msg}\n    `)
        }
      }

      if (!json) process.stderr.write(`${docsHere} of ${face.documents.length} doc(s), ${threadsHere} of ${face.threads.length} thread(s)\n`)
    }

    // Restore groups (v2+)
    if (backup.groups && backup.groups.length > 0) {
      if (!json) this.log(`\nRestoring ${backup.groups.length} group(s)...`)
      // Creating every group in the backup duplicated the ones still there.
      const existing = new Set<string>()
      try {
        const resp = await client.get('/v1/me/groups') as {data?: Array<Record<string, unknown>>}
        for (const t of resp.data ?? []) existing.add(String(t.name))
      } catch { /* without the list, create as before */ }

      for (const group of backup.groups) {
        if (!json) process.stderr.write(`  ${group.name}: `)
        if (existing.has(group.name)) {
          if (!json) process.stderr.write('exists, skipping\n')
          continue
        }

        try {
          const payload: Record<string, unknown> = {name: group.name}
          if (group.description) payload.description = group.description
          if (group.protocol) payload.protocol = group.protocol

          const created = await client.post('/v1/groups', {body: payload}) as Record<string, unknown>
          const groupId = created.id as string

          // Add tags
          if (group.tags.length > 0) {
            try {
              await client.post(`/v1/groups/${seg(groupId)}/tags`, {body: {tags: group.tags}})
            } catch { /* non-fatal */ }
          }

          // Add members (resolve aliases to iam_ids)
          for (const alias of group.members) {
            try {
              const face = await client.get(`/v1/faces/${seg(alias)}`) as Record<string, unknown>
              const iamId = (face.uid ?? face.id ?? face.iam_id) as string
              if (iamId) {
                await client.post(`/v1/groups/${seg(groupId)}/members`, {body: {iam_id: iamId}})
              }
            } catch { /* member may not exist yet */ }
          }

          groupsCreated++
          if (!json) process.stderr.write(`${group.members.length} member(s)\n`)
        } catch (err) {
          const msg = err instanceof FacesAPIError ? `${err.statusCode}: ${err.message}` : String(err)
          failures.push(`group "${group.name}" (${msg})`)
          if (!json) process.stderr.write(`failed: ${msg}\n`)
        }
      }
    }

    if (!json) {
      this.log(`\nRestore complete:`)
      this.log(`  Faces created: ${facesCreated}, skipped: ${facesSkipped}`)
      this.log(`  Documents uploaded: ${docsUploaded}`)
      this.log(`  Threads uploaded: ${threadsUploaded}`)
      if (groupsCreated > 0) this.log(`  Groups created: ${groupsCreated}`)
      if (skippedCorpus.length > 0) {
        this.log(`  Style corpus threads not restored: ${skippedCorpus.length}. Re-upload them with faces style:upload:`)
        for (const s of skippedCorpus) this.log(`    ${s}`)
      }
    }

    if (flags.compile) {
      if (!json) this.log('\nRunning compile:all...\n')
      await this.config.runCommand('compile:all', json ? ['--json'] : [])
    }

    const result = {faces_created: facesCreated, faces_skipped: facesSkipped, documents: docsUploaded, threads: threadsUploaded, groups_created: groupsCreated, corpus_threads_skipped: skippedCorpus, failures}
    // A partial restore must not exit like a complete one.
    if (failures.length > 0) {
      this.error(`${failures.length} item(s) were not restored:\n${failures.map((f) => `  ${f}`).join('\n')}`)
    }

    return result
  }

  private async createFace(client: FacesClient, face: BackupFace): Promise<boolean> {
    const payload: Record<string, unknown> = {name: face.name, alias: face.alias}
    if (face.description) payload.description = face.description
    if (face.specialty) payload.specialty = face.specialty
    if (face.profile_addendum) payload.profile_addendum = face.profile_addendum
    if (face.formula) {
      payload.formula = face.formula
      if (face.default_model) payload.default_model = face.default_model
    } else {
      if (face.basic_facts && Object.keys(face.basic_facts).length > 0) payload.basic_facts = face.basic_facts
      if (face.default_tools && face.default_tools.length > 0) payload.default_tools = face.default_tools
      if (face.default_model) payload.default_model = face.default_model
    }

    try {
      await client.post('/v1/faces', {body: payload})
      return true
    } catch (err) {
      if (err instanceof FacesAPIError && err.statusCode === 400) {
        return false
      }
      throw err
    }
  }

  private findLatestBackup(): string {
    const backupDir = path.join(os.homedir(), '.faces', 'backups')
    if (!fs.existsSync(backupDir)) this.error('No backups found in ~/.faces/backups/')

    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.json'))
      .sort()

    if (files.length === 0) this.error('No backups found in ~/.faces/backups/')
    return path.join(backupDir, files[files.length - 1])
  }
}
