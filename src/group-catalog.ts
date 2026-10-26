import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {quoteYaml, unquoteYaml} from './utils.js'
import {childPath} from './paths.js'

export const GROUPS_DIR = path.join(os.homedir(), '.faces', 'teams')

/**
 * Directory name for a group.
 *
 * Local groups are stored under a slug of their display name, so any comparison
 * between the server's groups and the local ones has to normalise the same way
 * in both directions. Exported because doing it in one direction only is how a
 * group whose name contains punctuation ends up looking orphaned every time.
 */
export function slugifyGroupName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export interface GroupFrontmatter {
  id?: string
  name: string
  description?: string
  tags?: string[]
  members?: string[]
  /**
   * Lines the CLI does not manage, kept as written. The faceteam skill adds
   * its own keys, and rewriting the file used to drop them.
   */
  extra?: string[]
}

/**
 * Text with any leading YAML frontmatter removed, however many blocks there
 * are. A TEAM.md handed to --protocol-file used to be stored whole, so the
 * server's protocol began with the file's own metadata.
 */
export function stripFrontmatter(text: string): string {
  let out = text
  while (/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(out)) out = out.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  return out.replace(/^\s*\n/, '')
}

function serializeFrontmatter(fm: GroupFrontmatter): string {
  const lines: string[] = ['---']
  if (fm.id) lines.push(`id: ${fm.id}`)
  lines.push(`name: ${quoteYaml(fm.name)}`)
  if (fm.description) lines.push(`description: ${quoteYaml(fm.description)}`)
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.join(', ')}]`)
  }
  if (fm.members && fm.members.length > 0) {
    lines.push(`members: [${fm.members.join(', ')}]`)
  }
  for (const line of fm.extra ?? []) lines.push(line)
  lines.push('---')
  return lines.join('\n')
}

const KNOWN_KEYS = new Set(['id', 'name', 'description', 'tags', 'members'])

function parseBlock(yamlBlock: string, fm: Partial<GroupFrontmatter>): void {
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    const key = colonIdx < 0 ? '' : line.slice(0, colonIdx).trim()
    if (!KNOWN_KEYS.has(key)) {
      // A key the CLI does not manage, or its indented continuation.
      if (line.trim() && !(fm.extra ?? []).includes(line)) fm.extra = [...(fm.extra ?? []), line]
      continue
    }

    // The first block wins: it is the newest write.
    if ((fm as Record<string, unknown>)[key] !== undefined) continue
    const val = line.slice(colonIdx + 1).trim()
    if (key === 'id') fm.id = unquoteYaml(val)
    else if (key === 'name') fm.name = unquoteYaml(val)
    else if (key === 'description') fm.description = unquoteYaml(val)
    else {
      const inner = val.replace(/^\[/, '').replace(/\]$/, '')
      const items = inner ? inner.split(',').map(s => s.trim()).filter(Boolean) : []
      if (key === 'tags') fm.tags = items
      else fm.members = items
    }
  }
}

function parseFrontmatter(content: string): {frontmatter: GroupFrontmatter | null; body: string} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  let match = content.match(block)
  if (!match) return {frontmatter: null, body: content}

  // Earlier versions stacked a new block on top of the old one; read them all
  // as one, so the next write collapses them.
  const fm: Partial<GroupFrontmatter> = {}
  let rest = content
  while (match) {
    parseBlock(match[1], fm)
    rest = rest.slice(match[0].length)
    match = rest.match(block)
  }

  if (!fm.name) return {frontmatter: null, body: content}
  return {frontmatter: fm as GroupFrontmatter, body: rest}
}

export class GroupCatalogService {
  writeGroup(name: string, fm: GroupFrontmatter, protocol?: string | null): void {
    try {
      const dir = childPath(GROUPS_DIR, name)
      fs.mkdirSync(dir, {recursive: true})
      const filePath = path.join(dir, 'TEAM.md')
      // Keep what the file already says beyond the CLI's keys.
      const existing = fs.existsSync(filePath) ? parseFrontmatter(fs.readFileSync(filePath, 'utf8')).frontmatter : null
      const merged: GroupFrontmatter = {...fm, extra: fm.extra ?? existing?.extra}
      const body = stripFrontmatter(protocol ?? '')
      const content = serializeFrontmatter(merged) + '\n' + body
      fs.writeFileSync(filePath, content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`warn: group catalog write failed: ${msg}\n`)
    }
  }

  readGroup(name: string): {frontmatter: GroupFrontmatter; body: string} | null {
    const filePath = path.join(childPath(GROUPS_DIR, name), 'TEAM.md')
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = parseFrontmatter(content)
    if (!parsed.frontmatter) return null
    return {frontmatter: parsed.frontmatter, body: parsed.body}
  }

  listGroups(): string[] {
    if (!fs.existsSync(GROUPS_DIR)) return []
    return fs.readdirSync(GROUPS_DIR, {withFileTypes: true})
      .filter(d => d.isDirectory() && fs.existsSync(path.join(GROUPS_DIR, d.name, 'TEAM.md')))
      .map(d => d.name)
  }

  /**
   * Whether TEAM.md carries anything beyond the frontmatter the CLI writes.
   *
   * For a group that still exists this body is the server's protocol and gets
   * overwritten on every sync. For one that does not, it is the only copy left,
   * which is the difference between tidying up and losing something.
   */
  hasLocalContent(name: string): boolean {
    const group = this.readGroup(name)
    return Boolean(group && group.body.trim())
  }

  /** The local folder holding the group with this id, if there is one. */
  findById(id: string): string | undefined {
    return this.listGroups().find((name) => this.readGroup(name)?.frontmatter.id === id)
  }

  deleteGroup(name: string): void {
    try {
      const dir = childPath(GROUPS_DIR, name)
      fs.rmSync(dir, {recursive: true, force: true})
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`warn: group catalog delete failed: ${msg}\n`)
    }
  }
}
