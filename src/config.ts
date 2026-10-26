import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CONFIG_PATH = path.join(os.homedir(), '.faces', 'config.json')

export const DEFAULT_BASE_URL = 'https://api.faces.sh'

export interface FacesConfig {
  base_url?: string
  /** The API the saved token and api_key belong to; they are sent nowhere else. */
  credentials_base_url?: string
  token?: string
  api_key?: string
  user_id?: string
  catalog?: string          // "true" (default) or "false": enable/disable local face catalog
  catalog_model?: string    // LLM for auto-generating descriptions (default: "gpt-5-nano")
  [key: string]: string | undefined
}

let warnedCorrupt = false

export function loadConfig(): FacesConfig {
  let raw: string
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  } catch {
    return {}
  }

  try {
    return JSON.parse(raw) as FacesConfig
  } catch {
    // Reading a broken file as empty said "log in" and then let the login
    // overwrite it, losing a saved api_key without a word.
    if (!warnedCorrupt) {
      process.stderr.write(`warn: ${CONFIG_PATH} is not valid JSON, so it is being ignored. It will be backed up before anything overwrites it.\n`)
      warnedCorrupt = true
    }

    return {}
  }
}

export function saveConfig(data: Partial<FacesConfig>): void {
  const dir = path.dirname(CONFIG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  backUpIfCorrupt()
  const existing = loadConfig()
  const merged = {...existing, ...data}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), {mode: 0o600})
}

function backUpIfCorrupt(): void {
  try {
    JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    const backup = `${CONFIG_PATH}.corrupt-${Date.now()}`
    fs.copyFileSync(CONFIG_PATH, backup)
    fs.chmodSync(backup, 0o600)
    process.stderr.write(`warn: the unreadable config was kept as ${backup}\n`)
  }
}

/** Save a token or api_key, recording which API it belongs to. */
export function saveCredentials(data: Pick<FacesConfig, 'token' | 'api_key' | 'user_id'>, baseUrl: string): void {
  saveConfig({...data, credentials_base_url: originOf(baseUrl)})
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export function setConfigKey(key: string, value: string): void {
  saveConfig({[key]: value})
}

export function clearConfig(): void {
  try {
    fs.unlinkSync(CONFIG_PATH)
  } catch {
    // ignore missing file
  }
}

export function maskedConfig(): FacesConfig {
  const cfg = loadConfig()
  const masked: FacesConfig = {...cfg}
  if (masked.token) masked.token = '***'
  if (masked.api_key) masked.api_key = '***'
  return masked
}

function isLocal(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
}

export interface ResolvedCredentials {
  token?: string
  apiKey?: string
  /** Why saved credentials were held back from this base URL, when they were. */
  withheld?: string
  /** The API key came from the config file, so a refused one may fall back to the saved login. */
  keySaved?: boolean
}

/**
 * The credentials to send to `baseUrl`.
 *
 * A flag or environment variable is a choice made for this run and is always
 * used. Saved ones belong to the API they were saved for: `--base-url` once
 * sent the saved session to whatever host it named, which echoed it back.
 * Nothing is sent over plain http except to this machine.
 */
export function resolveCredentials(flags: {token?: string; 'api-key'?: string}, baseUrl: string): ResolvedCredentials {
  const cfg = loadConfig()
  const explicitToken = flags.token !== undefined ? flags.token || undefined : process.env.FACES_TOKEN || undefined
  const explicitKey = flags['api-key'] !== undefined ? flags['api-key'] || undefined : process.env.FACES_API_KEY || undefined
  const tokenGiven = flags.token !== undefined || Boolean(process.env.FACES_TOKEN)
  const keyGiven = flags['api-key'] !== undefined || Boolean(process.env.FACES_API_KEY)

  let token = tokenGiven ? explicitToken : undefined
  let apiKey = keyGiven ? explicitKey : undefined
  let withheld: string | undefined
  const savedToken = tokenGiven ? undefined : cfg.token || undefined
  const savedKey = keyGiven ? undefined : cfg.api_key || undefined
  if (savedToken || savedKey) {
    const owner = originOf(cfg.credentials_base_url ?? cfg.base_url ?? DEFAULT_BASE_URL)
    if (owner === originOf(baseUrl)) {
      token ??= savedToken
      apiKey ??= savedKey
    } else {
      withheld = `The saved credentials belong to ${owner}, so they were not sent to ${originOf(baseUrl)}. ` +
        'Log in there, or pass --api-key or FACES_API_KEY for it.'
    }
  }

  let parsed: URL | undefined
  try {
    parsed = new URL(baseUrl)
  } catch {
    // an invalid base URL fails on the request itself, with its own message
  }

  if (parsed && parsed.protocol === 'http:' && !isLocal(parsed) && (token || apiKey)) {
    throw new Error(`Refusing to send credentials over plain http to ${parsed.origin}. Use https, or localhost for development.`)
  }

  return {token, apiKey, withheld, keySaved: Boolean(apiKey) && !keyGiven}
}

export function resolveBaseUrl(override?: string): string {
  if (override) return override
  if (process.env.FACES_BASE_URL) return process.env.FACES_BASE_URL
  const cfg = loadConfig()
  if (cfg.base_url) return cfg.base_url
  return 'https://api.faces.sh'
}

export function resolveToken(override?: string): string | undefined {
  // Empty string override means "no token": don't fall back to config/env
  if (override !== undefined) return override || undefined
  const env = process.env.FACES_TOKEN
  if (env) return env
  return loadConfig().token || undefined
}

export function resolveApiKey(override?: string): string | undefined {
  // Empty string override means "no API key": don't fall back to config/env
  if (override !== undefined) return override || undefined
  const env = process.env.FACES_API_KEY
  if (env) return env
  return loadConfig().api_key || undefined
}
