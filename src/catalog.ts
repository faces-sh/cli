import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {loadConfig} from './config.js'
import {MAX_FRONTMATTER_VALUE, quoteYaml, unquoteYaml} from './utils.js'
import {childPath} from './paths.js'

export const CATALOG_DIR = path.join(os.homedir(), '.faces', 'catalog')
export const CATALOG_INDEX = path.join(os.homedir(), '.faces', 'catalog.json')

export interface FaceFrontmatter {
  name: string
  description?: string
  alias: string
  attributes?: Record<string, string>
  tags?: string[]
  default_model?: string
  formula?: string | null
  component_counts?: number[]
  compiled_tokens?: number
  // Agent/user-managed fields preserved but not overwritten by CLI
  [key: string]: unknown
}

export interface FaceDataInput {
  name: string
  alias: string
  uid?: string
  description?: string | null
  basic_facts?: Record<string, string | {value: string}> | null
  tags?: string[] | null
  default_model?: string | null
  formula?: string | null
  component_counts?: number[] | null
  compile_tokens_synced?: number | null
}

function serializeFrontmatter(fm: FaceFrontmatter): string {
  const lines: string[] = ['---']
  lines.push(`name: ${quoteYaml(fm.name)}`)
  if (fm.description) lines.push(`description: ${quoteYaml(fm.description)}`)
  lines.push(`alias: ${quoteYaml(fm.alias)}`)
  if (fm.default_model) lines.push(`default_model: ${quoteYaml(fm.default_model)}`)
  if (fm.formula) lines.push(`formula: ${quoteYaml(fm.formula)}`)
  if (fm.attributes && Object.keys(fm.attributes).length > 0) {
    lines.push('attributes:')
    for (const [k, v] of Object.entries(fm.attributes)) {
      lines.push(`  ${k}: ${quoteYaml(String(v))}`)
    }
  }
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.join(', ')}]`)
  }
  // Written even at 0: the skills find faces still to compile by
  // `compiled_tokens: 0`, which never matched while it was left out.
  if (fm.compiled_tokens !== undefined) {
    lines.push(`compiled_tokens: ${fm.compiled_tokens}`)
  }
  // Keys the CLI does not manage, as written: a recipe's role, source_type,
  // sources_compiled and the like. They were carried along and then never
  // written, so every sync deleted them.
  for (const line of (fm.extraLines as string[] | undefined) ?? []) lines.push(line)
  lines.push('---')
  return lines.join('\n')
}

function parseFrontmatter(content: string): {frontmatter: FaceFrontmatter | null; body: string; extraKeys: Record<string, string>; partial: Partial<FaceFrontmatter>} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  let match = content.match(block)
  if (!match) return {frontmatter: null, body: content, extraKeys: {}, partial: {}}

  const fm: Partial<FaceFrontmatter> = {}
  const extraKeys: Record<string, string> = {}
  const extraLines: string[] = []
  const attributes: Record<string, string> = {}
  // profile_token_count is retired from the API. It stays
  // known so an old FACE.md drops the line on its next write, rather than
  // carrying it forever as a key the CLI does not manage.
  const knownKeys = new Set(['name', 'description', 'alias', 'attributes', 'tags', 'default_model', 'formula', 'component_counts', 'compiled_tokens', 'profile_token_count'])

  // Earlier versions stacked a new block on top of an old one; read every
  // leading block, the first (newest) winning, so the next write collapses them.
  let rest = content
  while (match) {
    let section: 'attributes' | 'extra' | null = null
    for (const line of match[1].split('\n')) {
      if (/^\s/.test(line) && line.trim()) {
        if (section === 'attributes') {
          const colonIdx = line.indexOf(':')
          if (colonIdx > 0) {
            const k = line.slice(0, colonIdx).trim()
            if (!(k in attributes)) attributes[k] = unquoteYaml(line.slice(colonIdx + 1))
          }
        } else if (section === 'extra') {
          extraLines.push(line)
        }

        continue
      }

      section = null
      const colonIdx = line.indexOf(':')
      if (colonIdx < 0) continue
      const key = line.slice(0, colonIdx).trim()
      const val = unquoteYaml(line.slice(colonIdx + 1))
      const seen = (fm as Record<string, unknown>)[key] !== undefined

      if (key === 'attributes') section = 'attributes'
      else if (!knownKeys.has(key)) {
        // Preserve agent/user-managed keys, with any indented lines under them.
        if (key in extraKeys) continue
        extraKeys[key] = val
        extraLines.push(line)
        section = 'extra'
      } else if (seen) continue
      else if (key === 'name') fm.name = val
      else if (key === 'description') fm.description = val
      else if (key === 'alias') fm.alias = val
      else if (key === 'default_model') fm.default_model = val
      else if (key === 'formula') fm.formula = val
      else if (key === 'tags') {
        const inner = val.replace(/^\[/, '').replace(/\]$/, '')
        fm.tags = inner ? inner.split(',').map(s => s.trim()).filter(Boolean) : []
      } else if (key === 'compiled_tokens') fm.compiled_tokens = Number(val) || 0
    }

    rest = rest.slice(match[0].length)
    match = rest.match(block)
  }

  if (Object.keys(attributes).length > 0) fm.attributes = attributes
  if (extraLines.length > 0) fm.extraLines = extraLines

  // A recipe without name or alias is still a frontmatter block: its body is
  // what follows it, and its keys are kept, so a write cannot stack on it.
  if (!fm.name || !fm.alias) return {frontmatter: null, body: rest, extraKeys, partial: fm}
  return {frontmatter: fm as FaceFrontmatter, body: rest, extraKeys, partial: fm}
}

const DEFAULT_BODY = '\n## Notes\n\n'

export class CatalogService {
  isEnabled(): boolean {
    const cfg = loadConfig()
    return cfg.catalog !== 'false'
  }

  writeFace(faceData: FaceDataInput, description?: string): void {
    if (!this.isEnabled()) return
    try {
      const alias = faceData.alias
      const dir = childPath(CATALOG_DIR, alias)
      fs.mkdirSync(dir, {recursive: true})

      const filePath = path.join(dir, 'FACE.md')

      let existingBody = DEFAULT_BODY
      let existingDescription: string | undefined
      let existingExtraLines: string[] = []
      if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf8')
        const parsed = parseFrontmatter(existing)
        if (parsed.body.trim()) existingBody = parsed.body
        if (parsed.partial.description) existingDescription = parsed.partial.description
        existingExtraLines = (parsed.partial.extraLines as string[] | undefined) ?? []
      }

      const fm: FaceFrontmatter = {
        name: faceData.name,
        alias,
      }

      // Description: explicit arg > existing > API response
      if (description) {
        fm.description = description
      } else if (faceData.description) {
        fm.description = faceData.description
      } else if (existingDescription) {
        // A description this size is corrupt, not long. Carrying it forward is
        // what kept it alive across writes; dropping it lets the next sync
        // replace it with the real one.
        if (existingDescription.length > MAX_FRONTMATTER_VALUE) {
          process.stderr.write(
            `warn: discarded a ${existingDescription.length}-character description on '${alias}': ` +
              'too large to be real. It will be restored from the server on the next sync.\n',
          )
        } else {
          fm.description = existingDescription
        }
      }

      if (faceData.default_model) fm.default_model = faceData.default_model
      if (faceData.formula) fm.formula = faceData.formula

      if (faceData.basic_facts && Object.keys(faceData.basic_facts).length > 0) {
        const attrs: Record<string, string> = {}
        for (const [k, v] of Object.entries(faceData.basic_facts)) {
          attrs[k] = typeof v === 'object' && v !== null && 'value' in v ? v.value : String(v)
        }
        fm.attributes = attrs
      }

      if (faceData.tags && faceData.tags.length > 0) fm.tags = faceData.tags
      // What has been compiled into the face, which is what compiled_tokens
      // means to the skills.
      if (typeof faceData.compile_tokens_synced === 'number') fm.compiled_tokens = faceData.compile_tokens_synced
      else fm.compiled_tokens = 0

      // Preserve agent/user-managed extra keys, as written.
      if (existingExtraLines.length > 0) fm.extraLines = existingExtraLines

      const content = serializeFrontmatter(fm) + '\n' + existingBody
      fs.writeFileSync(filePath, content)
      this.rebuildIndex()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`warn: catalog write failed: ${msg}\n`)
    }
  }

  deleteFace(alias: string): void {
    if (!this.isEnabled()) return
    try {
      const dir = childPath(CATALOG_DIR, alias)
      fs.rmSync(dir, {recursive: true, force: true})
      this.rebuildIndex()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`warn: catalog delete failed: ${msg}\n`)
    }
  }

  /** Update just tags on an existing FACE.md without touching other fields */
  updateTags(alias: string, tags: string[]): void {
    if (!this.isEnabled()) return
    try {
      const filePath = path.join(childPath(CATALOG_DIR, alias), 'FACE.md')
      if (!fs.existsSync(filePath)) return
      const content = fs.readFileSync(filePath, 'utf8')
      const parsed = parseFrontmatter(content)
      if (!parsed.frontmatter) return
      parsed.frontmatter.tags = tags
      const newContent = serializeFrontmatter(parsed.frontmatter) + '\n' + parsed.body
      fs.writeFileSync(filePath, newContent)
      this.rebuildIndex()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`warn: catalog tag update failed: ${msg}\n`)
    }
  }

  rebuildIndex(): void {
    if (!this.isEnabled()) return
    try {
      fs.mkdirSync(CATALOG_DIR, {recursive: true})

      const entries: FaceFrontmatter[] = []
      const dirs = fs.readdirSync(CATALOG_DIR, {withFileTypes: true})

      for (const dirent of dirs) {
        if (!dirent.isDirectory()) continue
        const faceMdPath = path.join(childPath(CATALOG_DIR, dirent.name), 'FACE.md')
        if (!fs.existsSync(faceMdPath)) continue
        const content = fs.readFileSync(faceMdPath, 'utf8')
        const {frontmatter} = parseFrontmatter(content)
        if (frontmatter) entries.push(frontmatter)
      }

      fs.writeFileSync(CATALOG_INDEX, JSON.stringify(entries, null, 2))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`warn: catalog index rebuild failed: ${msg}\n`)
    }
  }
}
