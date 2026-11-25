/**
 * Tool definitions. Every tool is a thin, well-described wrapper around `lib/` so the model never has
 * to run Python, guess a Zotero endpoint, or hand-write Zotero field XML.
 * @module dsh-zotero-cite/lib/tools
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { DEFAULT_BASE, authorizeWrite, listAttachments, listTopItems, probe } from './zotero.js'
import { runImport } from './import.js'
import { fetchCslItems, readCslItems, summarize } from './csl.js'
import { findDuplicateGroups, runMerge } from './merge.js'
import {
  DEFAULT_STYLE,
  LEFTOVER_PLACEHOLDER,
  applyZoteroPref,
  countFields,
  injectCitations,
  parseMapping,
  readDocx,
  writeDocx,
} from './docx.js'
import { collectCitations, extractParagraphs, writeReviewReport } from './review.js'

/**
 * `defineTool` only tags a definition for type inference. It is imported lazily so the plugin still
 * loads when the harness package cannot be resolved, for example when the bundle is loaded from a
 * profile that does not expose it.
 */
const identity = definition => definition
const { defineTool = identity } = await import('@deepseek-ai/dsh-tools').catch(() => ({}))

/**
 * Resolve a user-supplied path against the process working directory.
 * @param {string} input - absolute or relative path.
 * @returns {string} absolute path.
 */
const resolve = input => path.resolve(process.cwd(), input)

/**
 * Render one tool result as text.
 * @param {string} title - heading of the rendered block.
 * @param {string[]} lines - body lines.
 * @returns {{type: 'text', text: string}[]} rendered content.
 */
const text = (title, lines) => [{ type: 'text', text: [`${title}`, ...lines].join('\n') }]

/**
 * Count import plans by status.
 * @param {object[]} plans - plans from the import tool.
 * @returns {Record<string, number>} counts per status.
 */
function countByStatus(plans) {
  const counts = {}
  for (const plan of plans) counts[plan.status] = (counts[plan.status] ?? 0) + 1
  return counts
}

/**
 * Check the local Zotero API and the local write API.
 * @returns {object} the tool definition.
 */
const statusTool = defineTool({
  name: 'zotero_status',
  description:
    'Check whether Zotero Desktop answers on its local API and report what the library holds: top-level items, attachments, and whether the Zotero 9.1+ local write API is authorized. Run this first when a Zotero task fails to connect.',
  parameters: {
    base: {
      type: 'string',
      description: 'Zotero local API origin. Defaults to http://localhost:23119.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        base: { type: 'string' },
        reachable: { type: 'boolean' },
        topLevelItems: { type: 'integer' },
        attachments: { type: 'integer' },
        writeApi: { type: 'json' },
        error: { type: 'string' },
      },
    },
    render: (_args, value) =>
      text(value.reachable ? 'Zotero is reachable.' : 'Zotero is not reachable.', [
        `base: ${value.base}`,
        value.reachable ? `top-level items: ${value.topLevelItems}` : `error: ${value.error}`,
        value.reachable ? `attachments: ${value.attachments}` : '',
        value.writeApi?.available === true
          ? 'write API: available'
          : `write API: unavailable${value.writeApi?.reason === undefined ? '' : ` (${value.writeApi.reason})`}`,
      ].filter(line => line !== '')),
  },
  async execute(args) {
    const base = args.base ?? DEFAULT_BASE
    const result = await probe(base)
    if (!result.reachable) {
      return {
        base,
        reachable: false,
        error: result.error ?? 'unknown error',
        writeApi: { available: false, reason: 'Zotero is not reachable.' },
      }
    }
    const [attachments, writeApi] = await Promise.all([listAttachments(base), authorizeWrite(base)])
    return {
      base,
      reachable: true,
      topLevelItems: result.topLevelItems ?? 0,
      attachments: attachments.length,
      writeApi,
    }
  },
  presentCall: args => ({ card: 'generic', title: 'Check Zotero library', kind: 'other', rawInput: args }),
})

/**
 * Import a folder of PDFs and map each file to the item Zotero created.
 * @returns {object} the tool definition.
 */
const importTool = defineTool({
  name: 'zotero_import_pdfs',
  description:
    'Import a folder of PDFs into the local Zotero library and map every PDF back to the item Zotero created for it, matching by attachment filename, first-author surname, and year. Ambiguous files are reported with candidate items instead of being imported. Writes import_map.json into the work directory and returns the mapping the citation step needs.',
  parameters: {
    folder: {
      type: 'string',
      required: true,
      description: 'Absolute or relative path of the folder that holds the PDFs to import.',
    },
    workDir: {
      type: 'string',
      description: 'Directory that receives import_map.json. Defaults to the current working directory.',
    },
    dryRun: {
      type: 'boolean',
      description: 'When true (the default) only report what would be imported; nothing is written to Zotero.',
    },
    importUnmatched: {
      type: 'boolean',
      description: 'Import files that matched no existing item. Leave false unless the user asked for it, because unmatched imports create items from PDF metadata.',
    },
    limit: { type: 'integer', description: 'Import at most this many PDFs, for a trial run.' },
    base: { type: 'string', description: 'Zotero local API origin. Defaults to http://localhost:23119.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        folder: { type: 'string' },
        mapPath: { type: 'string' },
        dryRun: { type: 'boolean' },
        imported: { type: 'integer' },
        localUserKey: { type: 'string' },
        counts: { type: 'json' },
        items: { type: 'json' },
      },
    },
    render: (_args, value) =>
      text(value.dryRun ? 'Import plan (dry run, nothing written).' : 'Import finished.', [
        `map: ${value.mapPath}`,
        `files: ${value.items.length}`,
        ...Object.entries(value.counts).map(([status, count]) => `${status}: ${count}`),
        value.dryRun ? 'Set dryRun=false to write these imports into Zotero.' : '',
      ].filter(line => line !== '')),
  },
  async execute(args) {
    const base = args.base ?? DEFAULT_BASE
    const folder = resolve(args.folder)
    const workDir = resolve(args.workDir ?? '.')
    const dryRun = args.dryRun ?? true
    const map = await runImport({
      base,
      folder,
      workDir,
      dryRun,
      importUnmatched: args.importUnmatched ?? false,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    })
    return {
      folder: map.folder,
      mapPath: map.mapPath,
      dryRun: map.dryRun,
      imported: map.imported,
      ...(map.local_user_key === undefined ? {} : { localUserKey: map.local_user_key }),
      counts: countByStatus(map.items),
      items: map.items.map(item => ({
        file: item.file,
        ...(item.key === undefined ? {} : { key: item.key }),
        status: item.status,
        ...(item.candidates === undefined ? {} : { candidates: item.candidates.map(candidate => `${candidate.key} ${candidate.title}`) }),
      })),
    }
  },
  presentCall: args => ({ card: 'generic', title: 'Import PDFs into Zotero', kind: 'other', rawInput: args }),
})

/**
 * Find duplicate items and optionally merge them.
 * @returns {object} the tool definition.
 */
const duplicatesTool = defineTool({
  name: 'zotero_find_duplicates',
  description:
    'Group library items that share a DOI, or a normalized title with the same item type, and rank each group by which copy should survive (cited first, then most attachments, DOI, authors, item type). Reports by default; merging needs the local write API of Zotero 9.1 or later and permanently deletes the copies that lose.',
  parameters: {
    workDir: {
      type: 'string',
      description: 'Directory that receives duplicates_merge_instructions.json and .md. Defaults to the current working directory.',
    },
    merge: {
      type: 'boolean',
      description: 'Merge the groups instead of only reporting them. Destructive: children move to the surviving item and the other copies are deleted.',
    },
    citedKeys: {
      type: 'array',
      items: { type: 'string' },
      description: 'Item keys already cited in the draft. Cited items win as the surviving copy. When omitted, keys of import_map.json in workDir are used.',
    },
    base: { type: 'string', description: 'Zotero local API origin. Defaults to http://localhost:23119.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        writeApiAvailable: { type: 'boolean' },
        reason: { type: 'string' },
        groupCount: { type: 'integer' },
        mergedCount: { type: 'integer' },
        jsonPath: { type: 'string' },
        mdPath: { type: 'string' },
        groups: { type: 'json' },
      },
    },
    render: (_args, value) =>
      text(value.groupCount === 0 ? 'No duplicate items found.' : `${value.groupCount} duplicate group(s).`, [
        `write API: ${value.writeApiAvailable ? 'available' : `unavailable (${value.reason ?? 'unknown reason'})`}`,
        `merged groups: ${value.mergedCount}`,
        `report: ${value.jsonPath}`,
        `summary: ${value.mdPath}`,
        ...value.groups.slice(0, 10).map(group => `- keep ${group.target}: ${group.members.length} copies of "${group.members[0]?.title ?? group.fingerprint}"`),
        value.groups.length > 10 ? `... ${value.groups.length - 10} more group(s) in the report` : '',
      ].filter(line => line !== '')),
  },
  async execute(args) {
    const base = args.base ?? DEFAULT_BASE
    const workDir = resolve(args.workDir ?? '.')
    const items = await listTopItems(base)
    const cited = new Set(args.citedKeys ?? (await citedKeysFromMap(workDir)))
    const groups = findDuplicateGroups(items, cited)
    const authorization = args.merge === true ? await authorizeWrite(base) : { available: false, reason: 'merge=false: nothing was merged.' }
    const report = await runMerge({
      base,
      workDir,
      groups,
      merge: args.merge === true,
      ...(authorization.key === undefined ? {} : { apiKey: authorization.key }),
      ...(authorization.available ? {} : { unavailable: authorization.reason }),
    })
    return {
      writeApiAvailable: authorization.available,
      ...(authorization.reason === undefined ? {} : { reason: authorization.reason }),
      groupCount: groups.length,
      mergedCount: report.mergedCount,
      jsonPath: report.jsonPath,
      mdPath: report.mdPath,
      groups: report.groups.map(group => ({
        fingerprint: group.fingerprint,
        target: group.target,
        members: group.members.map(member => `${member.key} ${member.itemType} score=${member.score}`),
        ...(group.result === undefined ? {} : { result: group.result }),
      })),
    }
  },
  presentCall: args => ({ card: 'generic', title: 'Find duplicate Zotero items', kind: 'other', rawInput: args }),
})

/**
 * Read the cited keys of an import map, when one exists.
 * @param {string} workDir - directory that may hold import_map.json.
 * @returns {Promise<string[]>} item keys of the map.
 */
async function citedKeysFromMap(workDir) {
  try {
    const map = JSON.parse(await readFile(path.join(workDir, 'import_map.json'), 'utf8'))
    return (map.items ?? []).map(item => item?.key).filter(key => typeof key === 'string' && key !== '')
  } catch {
    return []
  }
}

/**
 * Export CSL JSON for the keys that will be cited.
 * @returns {object} the tool definition.
 */
const cslTool = defineTool({
  name: 'zotero_fetch_csl',
  description:
    'Export complete CSL JSON for library items and write csl_items.json, which the field injection tool embeds into citation fields. Pass item keys directly, or pass mapPath and let import_map.json supply them.',
  parameters: {
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'Zotero item keys to export.',
    },
    mapPath: {
      type: 'string',
      description: 'Path of an import_map.json whose resolved item keys should be exported. Used when keys is omitted.',
    },
    workDir: {
      type: 'string',
      description: 'Directory that receives csl_items.json. Defaults to the current working directory.',
    },
    base: { type: 'string', description: 'Zotero local API origin. Defaults to http://localhost:23119.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cslPath: { type: 'string' },
        localUserKey: { type: 'string' },
        count: { type: 'integer' },
        missing: { type: 'array', items: { type: 'string' } },
        items: { type: 'json' },
      },
    },
    render: (_args, value) =>
      text(`Exported ${value.count} CSL record(s).`, [
        `file: ${value.cslPath}`,
        `local user key: ${value.localUserKey}`,
        ...value.items.map(item => `- ${item.key} ${item.authors} ${item.year} ${item.title}`),
        value.missing.length === 0 ? '' : `missing keys: ${value.missing.join(', ')}`,
      ].filter(line => line !== '')),
  },
  async execute(args) {
    const base = args.base ?? DEFAULT_BASE
    const workDir = resolve(args.workDir ?? '.')
    const keys = args.keys ?? (args.mapPath === undefined ? [] : await keysOfMap(resolve(args.mapPath)))
    if (keys.length === 0) throw new Error('No item keys to export: pass keys, or a mapPath whose import_map.json has resolved keys.')
    const result = await fetchCslItems({ base, keys, workDir })
    return {
      cslPath: result.cslPath,
      localUserKey: result.localUserKey,
      count: result.items.length,
      missing: result.missing,
      items: result.items.map(item => ({ key: item.key, ...summarize(item.csl) })),
    }
  },
  presentCall: args => ({ card: 'generic', title: 'Export CSL JSON', kind: 'other', rawInput: args }),
})

/**
 * Read item keys from an import map.
 * @param {string} mapPath - path of import_map.json.
 * @returns {Promise<string[]>} resolved item keys.
 */
async function keysOfMap(mapPath) {
  const map = JSON.parse(await readFile(mapPath, 'utf8'))
  return (map.items ?? []).map(item => item?.key).filter(key => typeof key === 'string' && key !== '')
}

/**
 * Inject Zotero citation and bibliography fields into a .docx.
 * @returns {object} the tool definition.
 */
const injectTool = defineTool({
  name: 'docx_inject_citations',
  description:
    'Replace {{Z1}}, {{Z1,2}}, and {{BIB}} placeholders in a .docx with native Zotero citation and bibliography fields, so Zotero\'s Word tab recognises them and Refresh renumbers everything. Each placeholder must sit alone in its own run. Needs csl_items.json from zotero_fetch_csl; writes a new file and never edits the input.',
  parameters: {
    input: { type: 'string', required: true, description: 'Path of the draft .docx that holds the placeholders.' },
    output: { type: 'string', required: true, description: 'Path of the .docx to write with Zotero fields.' },
    mapping: {
      type: 'string',
      required: true,
      description: 'Placeholder to item key mapping, such as "Z1=ABCD1234;Z2=EFGH5678;Z1,2=IJKL9012|MNOP3456". Several keys in one field are separated by "|".',
    },
    cslPath: {
      type: 'string',
      description: 'Path of csl_items.json. Defaults to csl_items.json in the current working directory.',
    },
    style: {
      type: 'string',
      description: `CSL style id recorded in the document's ZOTERO_PREF. Defaults to ${DEFAULT_STYLE}.`,
    },
    displays: {
      type: 'json',
      description: 'Explicit display text per placeholder, e.g. {"Z1,2": "[1], [2]"}. Derived from the placeholder numbers when omitted.',
    },
    bibEntries: {
      type: 'array',
      items: { type: 'string' },
      description: 'Pre-formatted bibliography lines. Derived from the cited CSL records in citation order when omitted.',
    },
    bibliography: {
      type: 'boolean',
      description: 'Emit the bibliography field. Set false only when the document carries no {{BIB}} and must not get one.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        output: { type: 'string' },
        style: { type: 'string' },
        citations: { type: 'json' },
        bibEntryCount: { type: 'integer' },
        fields: { type: 'json' },
        leftover: { type: 'array', items: { type: 'string' } },
        missingMarkers: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, value) =>
      text(`Wrote ${value.output}`, [
        `citations: ${value.citations.length} field(s), bibliography entries: ${value.bibEntryCount}`,
        `fields: ${value.fields.citationFields} ZOTERO_ITEM, ${value.fields.bibliographyFields} ZOTERO_BIBL`,
        `style: ${value.style}`,
        value.leftover.length === 0 ? 'no placeholder left' : `leftover placeholders: ${value.leftover.join(', ')}`,
        value.missingMarkers.length === 0 ? '' : `placeholders not found in the document (must sit alone in one run): ${value.missingMarkers.join(', ')}`,
        'Next: open the file in Word and press Zotero > Refresh to renumber.',
      ].filter(line => line !== '')),
  },
  async execute(args) {
    const cslPath = resolve(args.cslPath ?? 'csl_items.json')
    const csl = await readCslItems(cslPath)
    if (csl.localUserKey === undefined || csl.localUserKey === '') {
      throw new Error(`${cslPath} has no local_user_key; re-export it with zotero_fetch_csl.`)
    }
    const mapping = typeof args.mapping === 'string' ? parseMapping(args.mapping) : new Map()
    if (mapping.size === 0) throw new Error('The mapping is required, for example "Z1=ABCD1234".')
    const style = args.style ?? DEFAULT_STYLE
    const input = resolve(args.input)
    const output = resolve(args.output)
    const { entries, documentXml, settingsXml } = await readDocx(input)
    const injected = injectCitations({
      documentXml,
      mapping,
      cslItems: csl.items,
      localUserKey: csl.localUserKey,
      ...(args.displays === undefined ? {} : { displays: args.displays }),
      ...(args.bibEntries === undefined ? {} : { bibEntries: args.bibEntries }),
      bibliography: args.bibliography ?? true,
    })
    await writeDocx(output, entries, {
      documentXml: injected.documentXml,
      settingsXml: applyZoteroPref(settingsXml, style),
    })
    return {
      output,
      style,
      citations: injected.citations,
      bibEntryCount: injected.bibEntryCount,
      fields: countFields(injected.documentXml),
      leftover: injected.leftover,
      missingMarkers: injected.missingMarkers,
    }
  },
  presentCall: args => ({ card: 'generic', title: 'Inject Zotero citation fields', kind: 'other', rawInput: args }),
})

/**
 * Verify the Zotero fields of a document.
 * @returns {object} the tool definition.
 */
const checkTool = defineTool({
  name: 'docx_check_citations',
  description:
    'Verify a .docx that should already carry Zotero fields: count citation and bibliography fields, list leftover {{...}} placeholders, confirm the ZOTERO_PREF document variable that tells Zotero which style to use, and check that every field is closed. Read-only.',
  parameters: {
    docx: { type: 'string', required: true, description: 'Path of the .docx to inspect.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        docx: { type: 'string' },
        ok: { type: 'boolean' },
        citationFields: { type: 'integer' },
        bibliographyFields: { type: 'integer' },
        leftover: { type: 'array', items: { type: 'string' } },
        zoteroPref: { type: 'boolean' },
        style: { type: 'string' },
        problems: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, value) =>
      text(value.ok ? 'Document looks correct.' : 'Document has problems.', [
        `citation fields: ${value.citationFields}`,
        `bibliography fields: ${value.bibliographyFields}`,
        `ZOTERO_PREF: ${value.zoteroPref ? `present (${value.style})` : 'missing'}`,
        value.leftover.length === 0 ? 'leftover placeholders: none' : `leftover placeholders: ${value.leftover.join(', ')}`,
        ...value.problems.map(problem => `problem: ${problem}`),
      ]),
  },
  async execute(args) {
    const file = resolve(args.docx)
    const { documentXml, settingsXml } = await readDocx(file)
    const fields = countFields(documentXml)
    const leftover = [...new Set(documentXml.match(LEFTOVER_PLACEHOLDER) ?? [])]
    const prefMatch = /<w:docVar w:name="ZOTERO_PREF" w:val="([^"]*)"/.exec(settingsXml)
    const zoteroPref = prefMatch !== null
    const style = prefMatch === null ? undefined : /<style id="([^"]+)"/.exec(decodeAttribute(prefMatch[1]))?.[1]
    const problems = []
    if (fields.begins !== fields.ends) problems.push(`unbalanced fields: ${fields.begins} begin, ${fields.ends} end`)
    if (fields.citationFields === 0) problems.push('no ZOTERO_ITEM citation field found')
    if (fields.bibliographyFields > 1) problems.push(`${fields.bibliographyFields} bibliography fields: Zotero needs exactly one`)
    if (!zoteroPref) problems.push('settings.xml has no ZOTERO_PREF document variable, so Zotero will not know the style')
    if (leftover.length > 0) problems.push(`placeholders left in the text: ${leftover.join(', ')}`)
    if (!documentXml.trimEnd().endsWith('</w:document>')) problems.push('document.xml is truncated')
    return {
      docx: file,
      ok: problems.length === 0,
      citationFields: fields.citationFields,
      bibliographyFields: fields.bibliographyFields,
      leftover,
      zoteroPref,
      ...(style === undefined ? {} : { style }),
      problems,
    }
  },
  presentCall: args => ({ card: 'generic', title: 'Check Zotero fields', kind: 'other', rawInput: args }),
})

/**
 * Decode XML attribute entities.
 * @param {string} value - escaped attribute text.
 * @returns {string} decoded text.
 */
function decodeAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/**
 * Write the citation review report for a draft.
 * @returns {object} the tool definition.
 */
const reportTool = defineTool({
  name: 'docx_citation_report',
  description:
    'Write citation_review_report.md for a draft: every citation grouped by reference, with its section and citing sentence, so a reviewer can mark each one 合理 / 存疑 / 不合理 after checking the source. Run it on the draft that still holds {{Zn}} placeholders, before injection; headings between sections are used as the position label.',
  parameters: {
    docx: { type: 'string', required: true, description: 'Path of the draft .docx that still holds {{Zn}} placeholders.' },
    mapping: {
      type: 'string',
      required: true,
      description: 'Placeholder to item key mapping, same shape as for docx_inject_citations, so references can be titled.',
    },
    cslPath: {
      type: 'string',
      description: 'Path of csl_items.json, used for titles and authors. Defaults to csl_items.json in the current working directory.',
    },
    workDir: {
      type: 'string',
      description: 'Directory that receives citation_review_report.md. Defaults to the current working directory.',
    },
    checklist: {
      type: 'boolean',
      description: 'Include the automatic coverage and distribution checks at the top of the report.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reportPath: { type: 'string' },
        citations: { type: 'integer' },
        sources: { type: 'integer' },
        unresolved: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, value) =>
      text(`Wrote ${value.reportPath}`, [
        `${value.citations} citation instance(s) across ${value.sources} reference(s)`,
        value.unresolved.length === 0 ? '' : `placeholders with no CSL record: ${value.unresolved.join(', ')}`,
        'Fill the 判断 / 备注 columns after checking each source, then hand the table back.',
      ].filter(line => line !== '')),
  },
  async execute(args) {
    const cslPath = resolve(args.cslPath ?? 'csl_items.json')
    const csl = await readCslItems(cslPath)
    const mapping = parseMapping(args.mapping)
    const file = resolve(args.docx)
    const { documentXml } = await readDocx(file)
    const occurrences = collectCitations(extractParagraphs(documentXml))
    const written = await writeReviewReport({
      workDir: resolve(args.workDir ?? '.'),
      documentName: path.basename(file),
      occurrences,
      mapping,
      cslItems: csl.items,
      checklist: args.checklist ?? false,
    })
    const unresolved = [...new Set(occurrences.map(occurrence => occurrence.key))].filter(
      token => (mapping.get(token) ?? []).every(key => !csl.items.has(key)),
    )
    return { reportPath: written.reportPath, citations: written.citations, sources: written.sources, unresolved }
  },
  presentCall: args => ({ card: 'generic', title: 'Write citation review report', kind: 'other', rawInput: args }),
})

/** Every tool this bundle registers. */
export const TOOLS = [statusTool, importTool, duplicatesTool, cslTool, injectTool, checkTool, reportTool]
