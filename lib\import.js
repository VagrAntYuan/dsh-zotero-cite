/**
 * Match a folder of PDFs against the local Zotero library and import the ones that are missing.
 * Matching uses the attachment filename and the first author's surname because that is what a
 * library copy and a downloaded paper share; ambiguous candidates are reported, never guessed.
 * @module dsh-zotero-cite/lib/import
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cslForKeys, importPdf, listAttachments, listTopItems } from './zotero.js'

/** Words that carry no identifying weight in a paper filename or title. */
const STOPWORDS = new Set([
  'pdf', 'est', 'jhm', 'science', 'nature', 'review', 'the', 'of', 'and', 'et', 'al', 'r', 's', 'v',
  'vol', 'pp', 'doi', 'research', 'journal', 'effects', 'effect', 'impact', 'study', 'studies',
  'analysis', 'new',
])

/** Delay between two connector imports, so Zotero's metadata lookup keeps up. */
const IMPORT_GAP_MS = 600

/**
 * Pause the current async step.
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
export const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Split a filename or title into identifying lowercase words.
 * @param {string} text - text to tokenize.
 * @returns {string[]} tokens longer than one character, without stopwords.
 */
export function tokenize(text) {
  const words = String(text).match(/[A-Za-z\u00C0-\u017F']+/g) ?? []
  return words.map(word => word.toLowerCase()).filter(word => word.length > 1 && !STOPWORDS.has(word))
}

/**
 * Read the four-digit year out of a filename, ignoring longer digit runs.
 * @param {string} filename - PDF filename.
 * @returns {number | undefined} the year, when present.
 */
export function filenameYear(filename) {
  const match = /(?<!\d)(19|20)\d{2}(?!\d)/.exec(filename)
  return match === null ? undefined : Number(match[0])
}

/**
 * Read the first year of an item's date field.
 * @param {object} item - Zotero API item.
 * @returns {number | undefined} the year, when present.
 */
export function itemYear(item) {
  const date = typeof item?.data?.date === 'string' ? item.data.date : ''
  const match = /(19|20)\d{2}/.exec(date)
  return match === null ? undefined : Number(match[0])
}

/**
 * List the surnames an item crediting those authors carries, in token form.
 * @param {object} item - Zotero API item.
 * @param {boolean} firstOnly - restrict to the first author.
 * @returns {string[]} surname tokens.
 */
function surnameTokens(item, firstOnly) {
  const creators = Array.isArray(item?.data?.creators) ? item.data.creators : []
  const chosen = firstOnly ? creators.slice(0, 1) : creators
  const tokens = []
  for (const creator of chosen) {
    const surname = typeof creator?.lastName === 'string' && creator.lastName !== ''
      ? creator.lastName
      : (typeof creator?.name === 'string' ? creator.name : '')
    tokens.push(...tokenize(surname))
  }
  return tokens
}

/**
 * Score how strongly one PDF filename points at one item.
 * @param {string} filename - PDF filename.
 * @param {object} item - candidate Zotero item.
 * @returns {{strong: boolean, weak: boolean, score: number}} the match strengths.
 */
export function scoreMatch(filename, item) {
  const fileTokens = tokenize(path.parse(filename).name)
  const lead = fileTokens.slice(0, 3)
  const firstAuthor = surnameTokens(item, true)
  const anyAuthor = surnameTokens(item, false)
  let score = 0
  for (const token of lead) if (firstAuthor.includes(token)) score++
  let strong = score > 0
  const surname = firstAuthor.find(token => token.length >= 2)
  if (!strong && fileTokens.length === 1 && fileTokens[0].length >= 6 && surname !== undefined) {
    const word = fileTokens[0]
    strong = word.startsWith(surname) || word.endsWith(surname)
    if (strong) score = 1
  }
  const weak = fileTokens.some(token => anyAuthor.includes(token))
  return { strong, weak, score }
}

/**
 * Pick the single best strong candidate, or collect the alternatives when the choice is ambiguous.
 * @param {string} filename - PDF filename.
 * @param {object[]} pool - candidate items.
 * @returns {{key: string, score: number} | {candidates: {key: string, matched: string, title: string, date: string}[]}}
 * the resolved item, or up to five candidates for review.
 */
export function resolveByName(filename, pool) {
  const ranked = []
  for (const item of pool) {
    const { strong, score } = scoreMatch(filename, item)
    if (!strong) continue
    ranked.push({ item, score })
  }
  if (ranked.length === 1) return { key: itemKeyOf(ranked[0].item), score: ranked[0].score }
  if (ranked.length > 1) {
    const best = Math.max(...ranked.map(entry => entry.score))
    const top = ranked.filter(entry => entry.score === best)
    if (top.length === 1) return { key: itemKeyOf(top[0].item), score: best }
  }
  return { candidates: candidatesFor(filename, pool) }
}

/**
 * Describe the closest items for a reviewer to choose from.
 * @param {string} filename - PDF filename.
 * @param {object[]} pool - candidate items.
 * @returns {{key: string, matched: string, title: string, date: string}[]} up to five candidates.
 */
export function candidatesFor(filename, pool) {
  const ranked = []
  for (const item of pool) {
    const { strong, weak, score } = scoreMatch(filename, item)
    if (!strong && !weak) continue
    ranked.push({ item, rank: strong ? 2 : 1, score })
  }
  ranked.sort((left, right) => right.rank - left.rank || right.score - left.score)
  return ranked.slice(0, 5).map(({ item }) => {
    const data = item.data ?? {}
    return {
      key: itemKeyOf(item),
      matched: matchLabel(filename, item),
      title: String(data.title ?? '').slice(0, 90),
      date: String(data.date ?? ''),
    }
  })
}

/**
 * Report the words a candidate shared with the filename.
 * @param {string} filename - PDF filename.
 * @param {object} item - candidate item.
 * @returns {string} comma-separated shared tokens.
 */
function matchLabel(filename, item) {
  const fileTokens = tokenize(path.parse(filename).name)
  const shared = surnameTokens(item, false).filter(token => fileTokens.includes(token))
  return [...new Set(shared)].join(', ')
}

/**
 * Read an item's key.
 * @param {object} item - Zotero API item.
 * @returns {string} the item key.
 */
export function itemKeyOf(item) {
  return item?.data?.key ?? item?.key ?? ''
}

/**
 * Build the filename-to-parent map used to spot PDFs the library already holds.
 * @param {{filename: string, key: string, parentItem?: string}[]} attachments - attachment rows.
 * @returns {Map<string, string>} lowercase filename to owning item key.
 */
export function attachmentIndex(attachments) {
  const index = new Map()
  for (const row of attachments) {
    index.set(row.filename.toLowerCase(), row.parentItem ?? row.key)
  }
  return index
}

/**
 * Decide, for every PDF in a folder, whether it is already in the library or needs importing.
 * @param {object} input - planning input.
 * @param {string} input.folder - folder holding the PDFs.
 * @param {{name: string, path: string}[]} input.files - PDF files found in that folder.
 * @param {object[]} input.items - top-level library items.
 * @param {Map<string, string>} input.attachments - filename index of existing attachments.
 * @param {boolean} [input.importUnmatched] - import files no candidate matched.
 * @returns {{file: string, path: string, status: string, key?: string, candidates?: object[]}[]} one plan
 * per file; status is `existing`, `matched`, `needs-review`, or `unmatched`.
 */
export function planImports({ files, items, attachments, importUnmatched = false }) {
  const plans = []
  for (const file of files) {
    const known = attachments.get(file.name.toLowerCase())
    if (known !== undefined) {
      plans.push({ file: file.name, path: file.path, status: 'existing', key: known })
      continue
    }
    const year = filenameYear(file.name)
    const yearPool = year === undefined ? items : items.filter(item => itemYear(item) === year)
    let resolved = resolveByName(file.name, yearPool)
    if ('candidates' in resolved && year !== undefined && yearPool.length !== items.length) {
      const wider = resolveByName(file.name, items)
      if ('key' in wider) {
        // A strong first-author hit outside the filename's year: offer it, do not assume it.
        plans.push({ file: file.name, path: file.path, status: 'needs-review', candidates: wider.candidates ?? candidatesFor(file.name, items) })
        continue
      }
      if (wider.candidates.length > 0) resolved = wider
    }
    if ('key' in resolved) {
      plans.push({ file: file.name, path: file.path, status: 'matched', key: resolved.key })
    } else if (resolved.candidates.length > 0) {
      plans.push({ file: file.name, path: file.path, status: 'needs-review', candidates: resolved.candidates })
    } else {
      plans.push({ file: file.name, path: file.path, status: importUnmatched ? 'matched' : 'unmatched' })
    }
  }
  return plans
}

/**
 * List the PDF files of a folder.
 * @param {string} folder - absolute folder path.
 * @returns {Promise<{name: string, path: string}[]>} PDF files, sorted by name.
 */
export async function listPdfs(folder) {
  const info = await stat(folder).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) throw new Error(`Not a folder: ${folder}`)
  const names = await readdir(folder)
  return names
    .filter(name => path.extname(name).toLowerCase() === '.pdf')
    .sort((left, right) => left.localeCompare(right))
    .map(name => ({ name, path: path.join(folder, name) }))
}

/**
 * Import a folder of PDFs into Zotero, then match the new items back by attachment filename.
 * @param {object} options - import options.
 * @param {string} options.base - Zotero server origin.
 * @param {string} options.folder - folder holding the PDFs.
 * @param {string} options.workDir - directory that receives `import_map.json`.
 * @param {boolean} [options.dryRun] - report without writing to the library.
 * @param {boolean} [options.importUnmatched] - import files that matched nothing.
 * @param {number} [options.limit] - stop after this many PDFs.
 * @returns {Promise<object>} the import map written to `workDir`.
 */
export async function runImport({ base, folder, workDir, dryRun = true, importUnmatched = false, limit }) {
  const allFiles = await listPdfs(folder)
  const files = limit === undefined ? allFiles : allFiles.slice(0, limit)
  const items = await listTopItems(base)
  const attachments = attachmentIndex(await listAttachments(base))
  const before = items
    .map(item => String(item?.data?.dateAdded ?? ''))
    .sort()
    .at(-1) ?? ''
  const plans = planImports({ files, items, attachments, importUnmatched })

  const toImport = plans.filter(plan => plan.status === 'matched' || plan.status === 'unmatched')
  if (!dryRun) {
    for (const [index, plan] of toImport.entries()) {
      const bytes = await readFile(plan.path)
      await importPdf(base, plan.path, bytes, `dsh-zotero-cite-${Date.now()}-${String(index).padStart(4, '0')}`)
      plan.status = 'imported'
      await sleep(IMPORT_GAP_MS)
    }
    if (toImport.length > 0) {
      await waitForNewItems(base, before)
      const refreshed = attachmentIndex(await listAttachments(base))
      for (const plan of toImport) {
        const key = refreshed.get(plan.file.toLowerCase())
        if (key === undefined) plan.status = 'unmatched'
        else plan.key = key
      }
    }
  }

  const map = {
    folder,
    local_user_key: await localUserKeyOf(base, plans),
    items: plans.map(plan => ({
      file: plan.file,
      ...(plan.key === undefined ? {} : { key: plan.key }),
      status: plan.status,
      ...(plan.candidates === undefined ? {} : { candidates: plan.candidates }),
    })),
  }
  await mkdir(workDir, { recursive: true })
  const mapPath = path.join(workDir, 'import_map.json')
  await writeFile(mapPath, `${JSON.stringify(map, null, 1)}\n`, 'utf8')
  return { ...map, mapPath, dryRun, imported: plans.filter(plan => plan.status === 'imported').length }
}

/**
 * Resolve the local user key for a map, tolerating a library that returned no items.
 * @param {string} base - Zotero server origin.
 * @param {object[]} plans - import plans, whose resolved keys prove the library has items.
 * @returns {Promise<string | undefined>} the local user key.
 */
async function localUserKeyOf(base, plans) {
  const key = plans.find(plan => plan.key !== undefined)?.key
  if (key === undefined) return undefined
  const { localUserKey } = await cslForKeys(base, [key])
  return localUserKey
}

/**
 * Poll the library until the imports made just now become visible.
 * @param {string} base - Zotero server origin.
 * @param {string} before - highest `dateAdded` seen before importing.
 * @returns {Promise<object[]>} newly created items.
 */
async function waitForNewItems(base, before) {
  let newest = []
  for (let round = 0; round < 4; round++) {
    await sleep(3_000)
    const items = await listTopItems(base)
    newest = items.filter(item => String(item?.data?.dateAdded ?? '') > before)
    if (newest.length > 0) return newest
  }
  return newest
}
