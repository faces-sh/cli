import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {RUSH_FLAG_DESCRIPTION, compileBlockedLabel, compileProgressLabel, localTime, makeRefusalMessage, msUntilStart, seg} from '../../utils.js'
import {pollCompileProgress, PollProgress} from '../../poll.js'

interface CompileItem {
  type: 'document' | 'thread'
  id: string
  alias: string
  label: string | null
}

export default class CompileAll extends BaseCommand {
  static description =
    'Compile all uncompiled documents and threads across all faces. A compile with a scheduled start is ' +
    'left to start on its own, and listed with its start time; --rush starts them all now.'

  static flags = {
    ...BaseCommand.baseFlags,
    timeout: Flags.integer({description: 'Per-item compile timeout in seconds', default: 600}),
    rush: Flags.boolean({description: RUSH_FLAG_DESCRIPTION, default: false}),
  }

  /**
   * Say what was left out and why, rather than returning a shorter list than
   * the account would suggest. The reason doubles as the repair.
   */
  private reportBlocked(blocked: Map<string, number>): void {
    if (blocked.size === 0) return
    const total = [...blocked.values()].reduce((a, b) => a + b, 0)
    const parts = [...blocked.entries()].map(([why, n]) => `${n} ${why}`).join(', ')
    this.log(`Skipping ${total} the server would refuse: ${parts}.`)
    if (blocked.has('no medium declared')) {
      this.log('  Declare one on each with: faces compile:doc:edit <id> --medium essay')
    }
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CompileAll)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    // Fetch all faces
    let faces: Array<Record<string, unknown>>
    try {
      // Every page: a compile sweep that silently skips faces past the first
      // page leaves sources uncompiled with nothing said about them.
      const all = await client.getAll('/v1/faces')
      faces = all.data
      if (all.truncated && !json) {
        process.stderr.write('Warning: the face list was cut short, so some faces were not examined.\n')
      }
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // Collect uncompiled items
    const items: CompileItem[] = []
    // Sources the server is already working on. Counted so a caller is told
    // why they were left out, rather than finding a shorter list than expected.
    let busy = 0
    // Sources the server would refuse. Reported by reason, because the reason
    // is the repair: 33 of 70 documents on a real account say "no medium", and
    // attempting them would be 33 refusals instead of one sentence.
    const blocked = new Map<string, number>()

    for (const face of faces) {
      const alias = face.alias as string
      if (face.formula) continue // composite faces have no source material

      // Check documents
      try {
        const docs = await client.get('/v1/compile/documents', {params: {alias}}) as Array<Record<string, unknown>>
        for (const doc of docs) {
          // Branch on `finishing` first: true means
          // the source is running, or queued for an automatic retry, and the
          // caller is meant to offer no action. Compiling it here would pay a
          // second time for work already in flight, which is the harm that
          // issue exists to stop. `synced` decides the rest.
          if (doc.finishing) {
            busy++
          } else if (doc.compilable === false) {
            const why = compileBlockedLabel(doc.compile_blocked_reason as string | null) || 'cannot be compiled'
            blocked.set(why, (blocked.get(why) ?? 0) + 1)
          } else if (!doc.synced) {
            items.push({
              type: 'document',
              id: doc.document_id as string,
              alias,
              label: (doc.label as string) ?? null,
            })
          }
        }
      } catch { /* no docs */ }

      // Check threads
      try {
        const threads = await client.get('/v1/compile/threads', {params: {alias}}) as Array<Record<string, unknown>>
        for (const thread of threads) {
          if (thread.finishing) {
            busy++
          } else if (thread.compilable === false) {
            const why = compileBlockedLabel(thread.compile_blocked_reason as string | null) || 'cannot be compiled'
            blocked.set(why, (blocked.get(why) ?? 0) + 1)
          } else if (!thread.synced) {
            items.push({
              type: 'thread',
              id: thread.thread_id as string,
              alias,
              label: (thread.label as string) ?? null,
            })
          }
        }
      } catch { /* no threads */ }
    }

    if (items.length === 0) {
      if (!json) {
        if (busy > 0) {
          this.log(
            `Nothing to compile. ${busy} source(s) are still being worked on by the server; they need ` +
              'no action and will finish on their own.',
          )
        } else if (blocked.size > 0) {
          this.log('Nothing to compile.')
        } else {
          this.log('Nothing to compile. All documents and threads are up to date.')
        }
        this.reportBlocked(blocked)
      }
      return {compiled: 0, failed: 0, scheduled: 0, items: []}
    }

    if (!json) {
      this.log(`Found ${items.length} item(s) to compile`)
      if (busy > 0) {
        this.log(`Skipping ${busy} the server is already working on; they need no action.`)
      }
      this.reportBlocked(blocked)
      this.log('')
    }

    let compiled = 0
    let failed = 0
    let scheduled = 0
    const results: Array<{type: string; id: string; alias: string; label: string | null; status: string; starts_at?: string | null; rush?: boolean}> = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const tag = `[${i + 1}/${items.length}]`
      const name = item.label ?? item.id.slice(0, 8)

      if (!json) process.stderr.write(`${tag} ${item.type} "${name}" (${item.alias})... `)

      const makeEndpoint = item.type === 'document'
        ? `/v1/compile/documents/${seg(item.id)}/make`
        : `/v1/compile/threads/${seg(item.id)}/make`

      const pollEndpoint = item.type === 'document'
        ? `/v1/compile/documents/${seg(item.id)}`
        : `/v1/compile/threads/${seg(item.id)}`

      try {
        const made = (await client.post(makeEndpoint, flags.rush ? {body: {rush: true}} : {})) as Record<string, unknown>
        const sched = {
          ...('starts_at' in made ? {starts_at: (made.starts_at as string | null) ?? null} : {}),
          ...(typeof made.rush === 'boolean' ? {rush: made.rush} : {}),
        }

        // A scheduled start is not waited for here: each would hold up the
        // next. It starts on its own.
        if (made.rush !== true && msUntilStart(made.starts_at) > 0) {
          scheduled++
          results.push({...item, status: 'scheduled', ...sched})
          if (!json) process.stderr.write(`scheduled, starts ${localTime(made.starts_at)}\n`)
          continue
        }

        // Polled per item rather than through /v1/compile/activity, which
        // would be the cheaper call if several were in flight. This loop
        // compiles one at a time and needs THIS item's terminal state to count
        // it as compiled or failed; activity reports what is running, not how a
        // given source ended, and says nothing at all once it has stopped.
        await pollCompileProgress(client, item.id, {
          // The body is discarded here, so do not re-read the whole source.
          fullOnFinish: false,
          timeoutMs: flags.timeout * 1000,
          endpoint: pollEndpoint,
          onProgress: (p: PollProgress) => {
            if (!json) process.stderr.write(`[${compileProgressLabel(p)}] `)
          },
        })

        compiled++
        results.push({...item, status: 'compiled', ...sched})
        if (!json) process.stderr.write('done\n')
      } catch (err) {
        // Unchanged since its last compile: nothing ran and nothing was
        // charged, so it is neither a success nor a failure of this run.
        if (err instanceof FacesAPIError && err.errorCode === 'already_compiled') {
          results.push({...item, status: 'already compiled'})
          if (!json) process.stderr.write('already compiled\n')
          continue
        }

        // --rush on one that has already started: it carries on as it is.
        if (err instanceof FacesAPIError && err.errorCode === 'compile_already_started') {
          results.push({...item, status: 'already started'})
          if (!json) process.stderr.write('already started, so --rush does not apply\n')
          continue
        }

        failed++
        const msg = err instanceof FacesAPIError ? makeRefusalMessage(err, item.id) : err instanceof Error ? err.message : String(err)
        results.push({...item, status: `failed: ${msg}`})
        if (!json) process.stderr.write(`failed: ${msg}\n`)
      }
    }

    if (!json) {
      this.log(`\nCompile complete: ${compiled} succeeded, ${failed} failed`)
      if (scheduled > 0) {
        this.log(`${scheduled} scheduled to start on their own. Follow them with: faces compile:status`)
      }
    }

    return {compiled, failed, scheduled, items: results}
  }
}
