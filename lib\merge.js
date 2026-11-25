/**
 * Find duplicate Zotero items and merge them through the local write API. Duplicates are grouped by
 * DOI or by normalized title within one item type; the surviving item is the one carrying the most
 * children, a DOI, and the more formal item type. Merging moves every child to that item and then
 * deletes the others, so it is destructive and always reported first.
 * @module dsh-zotero-cite/lib/merge
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deleteItems, getItem, setParent } from './zotero.js'

/** Item types ordered from the most to the least formal. */
const TYPE_RANK = {
  journalArticle: 4,
  conferencePaper: 3,
  book: 2,
  bookSection: 2,
  thesis: 2,
  preprint: 1,
}

/**
 * Normalize a DOI so two spellings compare equal.
 * @param {unknown} doi - raw DOI field.
 * @returns {string} lowercase bare DOI, or an empty string.
 */
export function normDoi(doi) {
  if (typeof doi !== 'string') return ''
  return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase().replace(/\.+$/, '')
}

/**
 * Normalize a title to letters and digits, so punctuation and markup do not split a duplicate.
 * @param {unknown} title - raw title field.
 * @returns {string} comparable title, or an empty string.
 */
export function normTitle(title) {
  if (typeof title !== 'string') return ''
  return title
    .replace(/<[^>]*>/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/gu, '')
}

/**
 * Compute the duplicate identity of an item.
 * @param {object} item - Zotero API item.
 * @returns {string} `doi:<value>` when a DOI exists, otherwise `title:<value>|<itemType>`.
 */
export function fingerprint(item) {
  const doi = normDoi(item?.data?.DOI)
  if (doi !== '') return `doi:${doi}`
  return `title:${normTitle(item?.data?.title)}|${String(item?.data?.itemType ?? '')}`
}

/**
 * Score how much of an item's metadata a merge should preserve.
 * @param {object} item - Zotero API item.
 * @param {Set<string>} cited - item keys the document cites.
 * @returns {number} the score; higher wins.
 */
export function itemScore(item, cited) {
  const data = item?.data ?? {}
  const key = data.key ?? item.key ?? ''
  const creators = Array.isArray(data.creators) ? data.creators.length : 0
  return (cited.has(key) ? 1000 : 0)
    + Number(item?.meta?.numChildren ?? item?.children?.length ?? 0) * 10
    + (normDoi(data.DOI) === '' ? 0 : 5)
    + Math.min(creators, 5)
    + (TYPE_RANK[data.itemType] ?? 0)
}

/**
 * Group items that describe the same work.
 * @param {object[]} items - top-level library items.
 * @param {Set<string>} cited - item keys the document cites.
 * @returns {{fingerprint: string, target: string, members: object[]}[]} groups with two or more members.
 */
export function findDuplicateGroups(items, cited = new Set()) {
  const byFingerprint = new Map()
  for (const item of items) {
    const data = item?.data ?? {}
    if (data.itemType === 'attachment' || data.itemType === 'note') continue
    if (normDoi(data.DOI) === '' && normTitle(data.title) === '') continue
    const group = byFingerprint.get(fingerprint(item)) ?? []
    group.push(item)
    byFingerprint.set(fingerprint(item), group)
  }
  const groups = []
  for (const [print, members] of byFingerprint) {
    if (members.length < 2) continue
    const ranked = members
      .map(item => ({
        key: item.data?.key ?? item.key ?? '',
        title: String(item.data?.title ?? ''),
        itemType: String(item.data?.itemType ?? ''),
        dateAdded: String(item.data?.dateAdded ?? ''),
        numChildren: Number(item?.meta?.numChildren ?? 0),
        score: itemScore(item, cited),
      }))
      .sort((left, right) => right.score - left.score || left.dateAdded.localeCompare(right.dateAdded) || left.key.localeCompare(right.key))
    groups.push({ fingerprint: print, target: ranked[0].key, members: ranked })
  }
  groups.sort((left, right) => left.members[0].title.localeCompare(right.members[0].title))
  return groups
}

/**
 * Merge one group: move every child of the losers onto the target, then delete the losers.
 * @param {object} options - merge options for one group.
 * @param {string} options.base - Zotero server origin.
 * @param {string} options.target - surviving item key.
 * @param {string[]} options.sources - keys to merge into the target and then delete.
 * @param {string} options.apiKey - write API key.
 * @returns {Promise<{moved: number, deleted: string[], failed: {key: string, reason: string}[]}>} outcome.
 */
async function mergeGroup({ base, target, sources, apiKey }) {
  let moved = 0
  const deleted = []
  const failed = []
  for (const source of sources) {
    try {
      const item = await getItem(base, source, true)
      for (const child of item.children ?? []) {
        const childKey = child?.data?.key ?? child?.key
        if (typeof childKey !== 'string' || childKey === '') continue
        await setParent(base, childKey, target, apiKey)
        moved++
      }
      await deleteItems(base, [source], apiKey)
      deleted.push(source)
    } catch (error) {
      failed.push({ key: source, reason: error.message })
    }
  }
  return { moved, deleted, failed }
}

/**
 * Merge duplicate groups, or describe the merges a user must perform by hand.
 * @param {object} options - run options.
 * @param {string} options.base - Zotero server origin.
 * @param {string} options.workDir - directory that receives the report file.
 * @param {{fingerprint: string, target: string, members: object[]}[]} options.groups - detected groups.
 * @param {boolean} [options.merge] - perform the merges instead of only reporting them.
 * @param {string} [options.apiKey] - write API key; required when `merge` is true.
 * @param {string} [options.unavailable] - why the write API is unavailable, when it is.
 * @returns {Promise<object>} the report, including the path of the written JSON/Markdown pair.
 */
export async function runMerge({ base, workDir, groups, merge = false, apiKey, unavailable }) {
  const report = {
    writeApiAvailable: apiKey !== undefined,
    ...(unavailable === undefined ? {} : { reason: unavailable }),
    groups: groups.map(group => ({
      fingerprint: group.fingerprint,
      target: group.target,
      members: group.members,
      ...(merge && apiKey !== undefined ? {} : { instruction: 'Merge these items in Zotero: keep the target and merge the others into it.' }),
    })),
  }
  if (merge && apiKey !== undefined) {
    for (const [index, group] of report.groups.entries()) {
      const sources = group.members.map(member => member.key).filter(key => key !== group.target)
      group.result = await mergeGroup({ base, target: group.target, sources, apiKey })
      report.groups[index] = group
    }
  }
  await mkdir(workDir, { recursive: true })
  const jsonPath = path.join(workDir, 'duplicates_merge_instructions.json')
  await writeFile(jsonPath, `${JSON.stringify(report, null, 1)}\n`, 'utf8')
  const mdPath = path.join(workDir, 'duplicates_merge_instructions.md')
  await writeFile(mdPath, renderMergeMarkdown(report), 'utf8')
  return { ...report, jsonPath, mdPath, mergedCount: report.groups.filter(group => group.result !== undefined).length }
}

/**
 * Render the merge report as Markdown.
 * @param {object} report - report from {@link runMerge}.
 * @returns {string} Markdown text.
 */
function renderMergeMarkdown(report) {
  const lines = ['# Duplicate merge report', '']
  if (!report.writeApiAvailable) {
    lines.push(`The local write API is unavailable: ${report.reason ?? 'unknown reason'}. Merge the groups below by hand in Zotero.`, '')
  }
  if (report.groups.length === 0) {
    lines.push('No duplicate items were found.', '')
    return lines.join('\n')
  }
  for (const group of report.groups) {
    lines.push(`## ${group.members[0]?.title ?? group.fingerprint}`, '')
    lines.push(`- fingerprint: \`${group.fingerprint}\``)
    lines.push(`- keep: \`${group.target}\``)
    for (const member of group.members) {
      const mark = member.key === group.target ? '(keep)' : '(merge into keep)'
      lines.push(`  - \`${member.key}\` ${mark} — ${member.itemType}, ${member.numChildren} child item(s), ${member.dateAdded}`)
    }
    if (group.result !== undefined) {
      const { moved, deleted, failed } = group.result
      lines.push(`- merged: ${moved} child item(s) moved, ${deleted.length} item(s) deleted, ${failed.length} failure(s)`)
      for (const failure of failed) lines.push(`  - \`${failure.key}\`: ${failure.reason}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
