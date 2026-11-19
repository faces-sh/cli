import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {FacesClient} from './client.js'
import {DECISION_MODELS} from './decisions.js'

export const MESSAGES_ENDPOINT = '/v1/messages'
export const RESPONSES_ENDPOINT = '/v1/responses'
export const CHAT_COMPLETIONS_ENDPOINT = '/v1/chat/completions'

const CACHE_PATH = path.join(os.homedir(), '.faces', 'models-cache.json')
const TTL_MS = 60 * 60 * 1000 // 1 hour

interface RawModel {
  id: string
  provider?: string
  endpoint?: string
  codex_eligible?: boolean
  /** chat | decision | image | transcription. Absent in caches written before the field. */
  kind?: string
}

interface ModelsCache {
  fetched_at: number
  models: RawModel[]
}

export interface RouteInfo {
  endpoint: string
  /** The resolved LLM id we routed on (undefined if it couldn't be determined). */
  llm?: string
  /** True when a free (OAuth-subscription) variant of this model exists in the catalog. */
  freeWhenConnected: boolean
}

/** Last-resort routing when the catalog can't tell us where a model lives. */
function fallbackEndpoint(llm?: string): string {
  if (llm && llm.startsWith('claude')) return MESSAGES_ENDPOINT
  return CHAT_COMPLETIONS_ENDPOINT
}

function readCache(): ModelsCache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as ModelsCache
  } catch {
    return null
  }
}

function writeCache(models: RawModel[]): void {
  try {
    const dir = path.dirname(CACHE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true, mode: 0o700})
    fs.writeFileSync(CACHE_PATH, JSON.stringify({fetched_at: Date.now(), models} satisfies ModelsCache), {mode: 0o600})
  } catch {
    // a cache write failure is non-fatal
  }
}

async function fetchModels(client: FacesClient): Promise<RawModel[]> {
  const raw = (await client.get('/v1/models')) as Record<string, unknown>
  const data = Array.isArray(raw) ? raw : (raw.data ?? raw.models ?? [])
  return data as RawModel[]
}

/**
 * Return the list of catalog models, served from a short-lived on-disk cache.
 * Falls back to a stale cache if the network fetch fails, and to an empty list
 * if there's nothing cached: callers degrade to {@link fallbackEndpoint}.
 */
async function getModels(client: FacesClient): Promise<RawModel[]> {
  const cache = readCache()
  if (cache && Date.now() - cache.fetched_at < TTL_MS) return cache.models

  try {
    const models = await fetchModels(client)
    writeCache(models)
    return models
  } catch {
    return cache?.models ?? []
  }
}

/**
 * Build an id → {endpoint, freeWhenConnected} map.
 *
 * The catalog lists each model once, under its lab's id, and `codex_eligible`
 * says whether it runs free on a linked ChatGPT subscription. It used to list
 * that free route as a second `openai_oauth` copy; that copy is still read so
 * a models cache written before the change routes the same until it expires.
 *
 * Keyed in lower case, because the server accepts an id in any case.
 */
function buildMap(models: RawModel[]): Map<string, {endpoint: string; freeWhenConnected: boolean}> {
  const map = new Map<string, {endpoint: string; freeWhenConnected: boolean}>()
  for (const m of models) {
    if (!m.id || !m.endpoint) continue
    // Only chat models route a chat. A decision model answers /v1/decisions and
    // /v1/systemone, never a chat body; an entry with no kind is from an old cache.
    if (m.kind && m.kind !== 'chat') continue
    const key = m.id.toLowerCase()
    const existing = map.get(key)
    const free = m.codex_eligible === true || m.provider === 'openai_oauth'
    if (existing) {
      existing.freeWhenConnected = existing.freeWhenConnected || free
    } else {
      map.set(key, {endpoint: m.endpoint, freeWhenConnected: free})
    }
  }
  return map
}

/** The message for a chat aimed at a decision model, or undefined when `llm` is not one. */
export function decisionModelError(llm?: string): string | undefined {
  if (!llm) return undefined
  const want = llm.toLowerCase()
  if (!(DECISION_MODELS as readonly string[]).includes(want)) return undefined
  return `${llm} is a decision model, not a chat model; use \`faces decide\` with @<face>:maestro-1/${llm}`
}

/**
 * Decide which API endpoint a chat request should be posted to, driven entirely
 * by the model catalog (GET /v1/models). `llm` is the downstream model, the part
 * of `model` after the first `/` (`gpt-5.4` in `@alice:maestro-1/gpt-5.4`).
 */
export async function resolveEndpoint(client: FacesClient, llm: string): Promise<RouteInfo> {
  const notChat = decisionModelError(llm)
  if (notChat) throw new Error(notChat)

  const map = buildMap(await getModels(client))
  // A lab-qualified id (google/gemma-4-31b-it) is served under its own id too.
  const key = llm.toLowerCase()
  const hit = map.get(key) ?? (key.includes('/') ? map.get(key.slice(key.indexOf('/') + 1)) : undefined)
  if (hit) return {endpoint: hit.endpoint, llm, freeWhenConnected: hit.freeWhenConnected}

  return {endpoint: fallbackEndpoint(llm), llm, freeWhenConnected: false}
}

/**
 * Whether a model runs on the user's own linked ChatGPT subscription, and so
 * costs them nothing, or always bills.
 *
 * Returns undefined when the catalog cannot say: an unknown model, or a cache
 * written before this field was read. Undefined must not be treated as "bills":
 * refusing to run because we are out of date is worse than running.
 */
export async function codexEligible(client: FacesClient, llm: string): Promise<boolean | undefined> {
  const want = llm.toLowerCase()
  const hits = (await getModels(client)).filter((m) => m.id?.toLowerCase() === want)
  if (hits.length === 0) return undefined
  // One entry per model now. A cache from before the change may still hold
  // paid and OAuth twins under one id; eligible on either means the free
  // route exists.
  if (hits.some((m) => m.codex_eligible === true)) return true
  if (hits.every((m) => m.codex_eligible === false)) return false
  return undefined
}
