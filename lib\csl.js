/**
 * Export CSL JSON for Zotero items and keep the result in the work directory, so the model can
 * read titles and authors while the injection tool reads the exact records.
 * @module dsh-zotero-cite/lib/csl
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cslForKeys } from './zotero.js'

/**
 * Summarize one CSL record for a mapping decision.
 * @param {object} csl - CSL JSON record.
 * @returns {{title: string, authors: string[], year: string, type: string}} human-readable fields.
 */
export function summarize(csl) {
  const authors = (Array.isArray(csl?.author) ? csl.author : [])
    .map(author => (typeof author?.family === 'string' && author.family !== '' ? author.family : (author?.literal ?? '')))
    .filter(name => name !== '')
  const year = String(csl?.issued?.['date-parts']?.[0]?.[0] ?? '')
  return { title: String(csl?.title ?? ''), authors, year, type: String(csl?.type ?? '') }
}

/**
 * Export CSL JSON for the requested keys and write `csl_items.json`.
 * @param {object} options - export options.
 * @param {string} options.base - Zotero server origin.
 * @param {string[]} options.keys - item keys to export.
 * @param {string} options.workDir - directory that receives `csl_items.json`.
 * @returns {Promise<object>} exported items with summaries, the missing keys, and the file path.
 */
export async function fetchCslItems({ base, keys, workDir }) {
  const unique = [...new Set(keys.map(key => String(key).trim()).filter(key => key !== ''))]
  if (unique.length === 0) throw new Error('No item keys given: pass the keys reported by the import step.')
  const { items, missing, localUserKey } = await cslForKeys(base, unique)
  await mkdir(workDir, { recursive: true })
  const cslPath = path.join(workDir, 'csl_items.json')
  await writeFile(cslPath, `${JSON.stringify({ local_user_key: localUserKey ?? null, items }, null, 1)}\n`, 'utf8')
  return {
    cslPath,
    localUserKey,
    missing,
    items: items.map(item => ({ key: item.key, ...summarize(item.csl) })),
  }
}

/**
 * Read a previously exported `csl_items.json` file.
 * @param {string} cslPath - path of the export.
 * @returns {Promise<{localUserKey?: string, items: Map<string, object>, byKey: object}>} records keyed by
 * item key, plus the raw parsed file.
 */
export async function readCslItems(cslPath) {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(cslPath, 'utf8')
  const parsed = JSON.parse(raw)
  const items = new Map()
  for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
    if (typeof entry?.key === 'string' && entry.csl !== undefined) items.set(entry.key, entry.csl)
  }
  return { localUserKey: parsed?.local_user_key ?? undefined, items, byKey: parsed }
}
