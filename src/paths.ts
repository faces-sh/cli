import path from 'node:path'

/**
 * `base/name`, refused unless it is a direct child of `base`.
 *
 * Folder names here come from aliases, group names and community FACE.md
 * frontmatter, and the catalog deletes folders recursively, so a name like
 * `../..` must never resolve anywhere else.
 */
export function childPath(base: string, name: string): string {
  const p = path.resolve(base, name)
  if (!name || path.dirname(p) !== path.resolve(base)) {
    throw new Error(`"${name}" cannot be used as a folder name under ${base}.`)
  }

  return p
}
