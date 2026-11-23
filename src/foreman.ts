/**
 * A state as a boolean proof: premise:* and state:* on /v1/states, which is CRUD plus one
 * proof read, and the commands that call a model through /v1/choices and /v1/decisions. The CLI
 * prints the server's `text` as it is; the proof's view is the server's alone.
 *
 * Which state: --state-id, else FACES_STATE_ID, else the nearest `.faces/state.local` or
 * `.faces/state` from this directory up (state.local wins in the same directory). `faces
 * state:create --use` and `faces state:use <id>` write `.faces/state` here.
 */
import fs from 'node:fs'
import path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from './base.js'
import {FacesAPIError, FacesClient} from './client.js'
import {CONVERSATIONS_PATH, parseDependsOn, premiseValue} from './conversation.js'
import {seg} from './utils.js'

export const STATE_DIR = '.faces'
export const STATE_FILE = 'state'
export const STATE_LOCAL_FILE = 'state.local'

/** The state file that applies here, and the id in it, or undefined when there is none. */
export function findStateFile(from = process.cwd()): {file: string; id: string} | undefined {
  let dir = path.resolve(from)
  for (;;) {
    for (const name of [STATE_LOCAL_FILE, STATE_FILE]) {
      const file = path.join(dir, STATE_DIR, name)
      try {
        const id = fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0]
        if (id) return {file, id}
      } catch {
        // not here
      }
    }
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/** Write `.faces/state` (or `.faces/state.local`) in this directory; returns the path written. */
export function writeStateFile(id: string, local = false, dir = process.cwd()): string {
  const d = path.join(dir, STATE_DIR)
  fs.mkdirSync(d, {recursive: true})
  const file = path.join(d, local ? STATE_LOCAL_FILE : STATE_FILE)
  fs.writeFileSync(file, id + '\n')
  return file
}

/** Keys from repeatable, comma-separated flags; a key holding a comma goes in double quotes. */
export function keyList(raw: string[] | undefined, flag: string): string[] | undefined {
  if (!raw || raw.length === 0) return undefined
  const out: string[] = []
  for (const r of raw) out.push(...parseDependsOn(r, flag))
  return [...new Set(out)]
}

export {premiseValue}

export const stateIdFlag = {
  'state-id': Flags.string({
    description: 'The state (fs_...). Default: FACES_STATE_ID, else .faces/state.local or .faces/state here or above.',
    env: 'FACES_STATE_ID',
  }),
}

export const asFlag = {
  as: Flags.string({description: 'Who writes: your name, as a claim names it. A write into a branch another has claimed is refused (409) unless it is theirs.'}),
}

/** A command that sends one foreman request and prints the server's reply text. */
export abstract class ReplyCommand extends BaseCommand {
  protected stateId(flags: {'state-id'?: string}, positional?: string): string {
    const id = positional || flags['state-id'] || findStateFile()?.id
    if (!id) {
      this.error('No state here: no --state-id, no FACES_STATE_ID and no .faces/state in this directory or above. ' +
        'faces state:create --use makes one; faces state:use <id> uses one of yours.')
    }
    return id
  }

  protected statePath(id: string, route: string): string {
    return `${CONVERSATIONS_PATH}/${seg(id)}${route}`
  }

  /** Send, print the reply's text (or the JSON with --json), and exit non-zero on a refusal. */
  protected async reply(
    client: FacesClient,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    p: string,
    opts: {body?: Record<string, unknown>; params?: Record<string, string>} = {},
  ): Promise<Record<string, unknown>> {
    let got: {status: number; ok: boolean; data: Record<string, unknown>}
    try {
      got = await client.stateReply(method, p, opts)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }
    return this.show(got)
  }

  protected show(got: {status: number; ok: boolean; data: Record<string, unknown>}): Record<string, unknown> {
    const {data} = got
    // a refusal exits 1; its reply is still the output (stderr in text mode)
    if (!got.ok) process.exitCode = 1
    if (this.jsonEnabled()) return got.ok ? data : {...data, error: {message: data.error, status: got.status}}
    const text = typeof data.text === 'string' ? data.text : JSON.stringify(data)
    if (got.ok) this.log(text)
    else process.stderr.write(text + '\n')
    return data
  }
}

/** Drop undefined fields: the routes refuse fields they do not take, and unset is not null. */
export function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}

/** --problog and --dot (and the global --json): the proof's formats; text by default. */
export const formatFlags = {
  problog: Flags.boolean({description: 'The proof as runnable ProbLog.', default: false, exclusive: ['dot']}),
  dot: Flags.boolean({description: 'The proof as Graphviz dot.', default: false, exclusive: ['problog']}),
}

export function formatOf(flags: {problog?: boolean; dot?: boolean}, json: boolean): string {
  if (json) return 'json'
  if (flags.problog) return 'problog'
  if (flags.dot) return 'dot'
  return 'text'
}

/** --face: the face whose calls these are (billed per call). */
export const faceFlag = {
  face: Flags.string({description: 'The face that does it: @alias (faces face:list --for "<the task>" ranks them).', required: true}),
}

export function faceRef(face: string): string {
  const f = face.trim()
  return f.startsWith('@') || f.startsWith('(') ? f : '@' + f
}
