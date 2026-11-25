/**
 * Local Zotero HTTP client. Zotero's desktop build serves two surfaces on one port: a read-only
 * `/api/` mirror of the library and a `/connector/` endpoint that writes, plus the optional
 * `/api/local/` write API of Zotero 9.1 and later. This module wraps all of them and keeps the
 * version headers, pagination, and error text in one place.
 * @module dsh-zotero-cite/lib/zotero
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default port of the Zotero desktop HTTP server. */
export const DEFAULT_BASE = 'http://localhost:23119'

/** Page size requested from the read-only item endpoints. */
const PAGE_SIZE = 100

/** Longest key list sent as one `itemKey` query parameter. */
const KEY_BATCH = 40

/**
 * Build request headers for the local API.
 * @returns {Record<string, string>} headers understood by Zotero 7 and later.
 */
function apiHeaders() {
  return { 'User-Agent': 'dsh-zotero-cite', 'Zotero-API-Version': '3' }
}

/**
 * Normalize a user-supplied server origin.
 * @param {string} [base] - origin such as `http://localhost:23119`; trailing slashes are dropped.
 * @returns {string} origin without a trailing slash.
 */
export function normalizeBase(base) {
  const value = (base ?? DEFAULT_BASE).trim().replace(/\/+$/, '')
  return value === '' ? DEFAULT_BASE : value
}

/**
 * Perform one request against the local Zotero server.
 * @param {string} base - server origin.
 * @param {string} route - path beginning with `/`.
 * @param {object} [options] - fetch options plus `timeoutMs`.
 * @returns {Promise<Response>} the raw response.
 */
export async function request(base, route, options = {}) {
  const { timeoutMs = 15_000, ...init } = options
  const url = `${base}${route}`
  try {
    return await fetch(url, {
      ...init,
      headers: { ...apiHeaders(), ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    const hint = cause?.name === 'TimeoutError' ? 'timed out' : 'could not connect'
    throw new Error(`Zotero ${hint} at ${url}. Start Zotero Desktop and keep its local API enabled.`)
  }
}

/**
 * Read one JSON response and fail with the server's own message when it is not a success.
 * @param {Response} response - response to consume.
 * @param {string} what - short description used in the error text.
 * @returns {Promise<any>} parsed body, or `undefined` for an empty body.
 */
async function readJson(response, what) {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${what} failed: HTTP ${response.status} ${text.slice(0, 300)}`.trim())
  }
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} returned a non-JSON body: ${text.slice(0, 200)}`)
  }
}

/**
 * Check that the local server answers.
 * @param {string} base - server origin.
 * @returns {Promise<{reachable: boolean, topLevelItems?: number, error?: string}>} probe result.
 */
export async function probe(base) {
  try {
    const response = await request(base, `/api/users/0/items/top?limit=1&start=0`, { timeoutMs: 6_000 })
    if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` }
    const total = response.headers.get('total-results')
    return { reachable: true, ...(total === null ? {} : { topLevelItems: Number(total) }) }
  } catch (error) {
    return { reachable: false, error: error.message }
  }
}

/**
 * List every top-level item of the library.
 * @param {string} base - server origin.
 * @param {number} [max] - stop after this many items; unlimited when omitted.
 * @returns {Promise<object[]>} Zotero API items in library order.
 */
export async function listTopItems(base, max = Number.POSITIVE_INFINITY) {
  const items = []
  for (let start = 0; items.length < max; start += PAGE_SIZE) {
    const response = await request(base, `/api/users/0/items/top?limit=${PAGE_SIZE}&start=${start}`)
    const page = await readJson(response, 'Listing top-level items')
    if (!Array.isArray(page) || page.length === 0) break
    items.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return items.slice(0, max === Number.POSITIVE_INFINITY ? items.length : max)
}

/**
 * List every attachment item, which is how a PDF is matched back to its bibliographic parent.
 * @param {string} base - server origin.
 * @returns {Promise<{key: string, filename: string, parentItem?: string}[]>} attachment rows.
 */
export async function listAttachments(base) {
  const rows = []
  for (let start = 0; ; start += PAGE_SIZE) {
    const response = await request(base, `/api/users/0/items?itemType=attachment&limit=${PAGE_SIZE}&start=${start}`)
    const page = await readJson(response, 'Listing attachments')
    if (!Array.isArray(page) || page.length === 0) break
    for (const item of page) {
      const data = item?.data ?? {}
      if (typeof data.filename !== 'string' || data.filename === '') continue
      rows.push({ key: data.key ?? item.key, filename: data.filename, ...(data.parentItem ? { parentItem: data.parentItem } : {}) })
    }
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

/**
 * Read one item, including its child rows when asked.
 * @param {string} base - server origin.
 * @param {string} key - item key.
 * @param {boolean} [withChildren] - include `meta.numChildren` and children list.
 * @returns {Promise<object>} the Zotero API item.
 */
export async function getItem(base, key, withChildren = false) {
  const response = await request(base, `/api/users/0/items/${encodeURIComponent(key)}?format=json`)
  const item = await readJson(response, `Reading item ${key}`)
  if (withChildren) {
    const childResponse = await request(base, `/api/users/0/items/${encodeURIComponent(key)}/children?format=json`)
    const children = await readJson(childResponse, `Reading children of ${key}`)
    return { ...item, children: Array.isArray(children) ? children : [] }
  }
  return item
}

/**
 * Export CSL JSON for a set of items. The collection endpoint must be used: a single-item request
 * with `format=csljson` fails on Zotero's local server.
 * @param {string} base - server origin.
 * @param {string[]} keys - item keys, in the order the caller wants them reported.
 * @returns {Promise<{items: {key: string, csl: object}[], missing: string[], localUserKey?: string}>}
 * exported items; `csl` is the complete CSL JSON record.
 */
export async function cslForKeys(base, keys) {
  const wanted = [...new Set(keys.filter(key => typeof key === 'string' && key !== ''))]
  const found = new Map()
  let localUserKey
  for (let index = 0; index < wanted.length; index += KEY_BATCH) {
    const batch = wanted.slice(index, index + KEY_BATCH)
    const response = await request(base, `/api/users/0/items?itemKey=${batch.join(',')}&format=csljson`)
    const payload = await readJson(response, 'Exporting CSL JSON')
    const list = Array.isArray(payload) ? payload : (payload?.items ?? [])
    for (const csl of list) {
      const id = String(csl?.id ?? '')
      const match = /\/items\/([^/?#]+)$/.exec(id)
      if (!match) continue
      found.set(decodeURIComponent(match[1]), csl)
      localUserKey ??= /\/users\/local\/([^/]+)\/items\//.exec(id)?.[1]
    }
  }
  const items = []
  const missing = []
  for (const key of wanted) {
    const csl = found.get(key)
    if (csl === undefined) missing.push(key)
    else items.push({ key, csl })
  }
  return { items, missing, ...(localUserKey === undefined ? {} : { localUserKey }) }
}

/**
 * Derive the library's local user key, which appears inside every `zotero.org/users/local/<key>`
 * item URI and is required to build citation fields.
 * @param {string} base - server origin.
 * @returns {Promise<string | undefined>} the local user key, when the library holds at least one item.
 */
export async function localUserKey(base) {
  const [first] = await listTopItems(base, 1)
  const key = first?.data?.key ?? first?.key
  if (typeof key !== 'string') return undefined
  const { localUserKey: resolved } = await cslForKeys(base, [key])
  return resolved
}

/**
 * Upload one PDF through the connector API, which creates an item and recognises its metadata.
 * The response carries no item key, so callers must re-read the library afterwards.
 * @param {string} base - server origin.
 * @param {string} filePath - absolute path of the PDF.
 * @param {Buffer} bytes - file contents.
 * @param {string} sessionId - connector session identifier, unique per upload.
 * @returns {Promise<void>} resolves once Zotero accepted the file.
 */
export async function importPdf(base, filePath, bytes, sessionId) {
  const metadata = {
    sessionID: sessionId,
    url: `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`,
    title: path.basename(filePath),
  }
  const response = await request(base, '/connector/saveStandaloneAttachment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-Metadata': JSON.stringify(metadata) },
    body: bytes,
    timeoutMs: 120_000,
  })
  if (response.status !== 201) {
    const text = await response.text()
    throw new Error(`Import of ${path.basename(filePath)} failed: HTTP ${response.status} ${text.slice(0, 200)}`.trim())
  }
  await response.text()
}

/**
 * Read the write API key that Zotero stores for this machine.
 * @returns {Promise<string | undefined>} a remembered key, if one exists.
 */
async function rememberedKey() {
  try {
    const raw = await readFile(path.join(homedir(), 'Zotero', 'localAPIKeys.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const keys = Array.isArray(parsed?.keys) ? parsed.keys : []
    for (const entry of keys) {
      const key = typeof entry === 'string' ? entry : entry?.key
      if (typeof key === 'string' && key !== '') return key
    }
  } catch {
    // No remembered key: the caller can still ask for a new authorization.
  }
  return undefined
}

/**
 * Obtain a write API key for the local library. Zotero 9.1 and later authorize an application once
 * and remember the decision; earlier versions answer 404, which means only the connector can write.
 * @param {string} base - server origin.
 * @param {string} appName - application name shown in Zotero's authorization dialog.
 * @returns {Promise<{available: boolean, key?: string, reason?: string}>} authorization outcome.
 */
export async function authorizeWrite(base, appName = 'dsh-zotero-cite') {
  const remembered = await rememberedKey()
  if (remembered !== undefined) {
    const usable = await verifyWrite(base, remembered)
    if (usable) return { available: true, key: remembered }
  }
  try {
    const response = await request(base, '/api/local/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName, remember: true }),
      timeoutMs: 120_000,
    })
    if (response.status === 404) {
      return { available: false, reason: 'This Zotero version has no local write API (needs 9.1 or later); duplicates can only be reported, not merged.' }
    }
    const payload = await readJson(response, 'Requesting the Zotero write API key')
    const key = payload?.key
    if (typeof key !== 'string' || key === '') return { available: false, reason: 'Zotero did not return a write API key.' }
    if (!(await verifyWrite(base, key))) return { available: false, reason: 'Zotero issued a write API key that the library rejected.' }
    return { available: true, key }
  } catch (error) {
    return { available: false, reason: error.message }
  }
}

/**
 * Confirm that a write key is accepted by the library.
 * @param {string} base - server origin.
 * @param {string} key - candidate write API key.
 * @returns {Promise<boolean>} whether the request succeeded.
 */
export async function verifyWrite(base, key) {
  try {
    const response = await request(base, '/api/users/0/settings', { headers: { 'Zotero-API-Key': key }, timeoutMs: 10_000 })
    await response.text()
    return response.ok
  } catch {
    return false
  }
}

/**
 * Move an item under a new parent, such as an attachment that belongs to a surviving duplicate.
 * @param {string} base - server origin.
 * @param {string} key - item to move.
 * @param {string} parent - destination parent item key.
 * @param {string} apiKey - write API key.
 * @returns {Promise<void>} resolves when the move is stored.
 */
export async function setParent(base, key, parent, apiKey) {
  const item = await getItem(base, key)
  const version = item?.version
  if (typeof version !== 'number') throw new Error(`Cannot move ${key}: Zotero returned no item version.`)
  const response = await request(base, `/api/users/0/items/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Zotero-API-Key': apiKey, 'If-Unmodified-Since-Version': String(version) },
    body: JSON.stringify({ parentItem: parent }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Moving ${key} failed: HTTP ${response.status} ${text.slice(0, 200)}`.trim())
}

/**
 * Delete items permanently.
 * @param {string} base - server origin.
 * @param {string[]} keys - item keys to erase.
 * @param {string} apiKey - write API key.
 * @returns {Promise<void>} resolves when Zotero confirms the deletion.
 */
export async function deleteItems(base, keys, apiKey) {
  if (keys.length === 0) return
  const response = await request(base, `/api/users/0/items?itemKey=${keys.join(',')}`, {
    method: 'DELETE',
    headers: { 'Zotero-API-Key': apiKey },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Deleting ${keys.join(', ')} failed: HTTP ${response.status} ${text.slice(0, 200)}`.trim())
}
