/** GET /v1/media: the kinds of writing a source can be, each with a description and what it covers. */
import {table} from './utils.js'

export const MEDIA_PATH = '/v1/media'

export interface Medium {
  name?: string
  description?: string
  subcategories?: string[]
}

/** The media out of the response, whatever wraps them. */
export function mediaOf(raw: unknown): Medium[] {
  const data = Array.isArray(raw) ? raw : ((raw as Record<string, unknown> | null)?.data ?? [])
  return Array.isArray(data) ? (data as Medium[]) : []
}

/** The media as a table a person reads: name, description, subcategories. */
export function mediaLines(media: Medium[]): string[] {
  if (media.length === 0) return ['No media.']
  const rows = media.map((m) => [String(m.name ?? ''), String(m.description ?? ''), (m.subcategories ?? []).join(', ')])
  return table(['MEDIUM', 'DESCRIPTION', 'COVERS'], rows)
}
