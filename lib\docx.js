/**
 * Write native Zotero citation and bibliography fields into a Word document. Each `{{Zn}}`
 * placeholder becomes a `ZOTERO_ITEM` field that Zotero's Word add-in recognises, and `{{BIB}}`
 * becomes the `ZOTERO_BIBL` bibliography field, so Refresh in Word renumbers citations and rebuilds
 * the bibliography from the live library.
 * @module dsh-zotero-cite/lib/docx
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { readZip, writeZip } from './zip.js'

/** Character formatting copied from Zotero's own field output: Times New Roman with 宋体 fallback. */
const RPR = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>'

/** Paragraph formatting of bibliography entries. */
const BIB_PPR = '<w:pPr><w:ind w:left="360"/><w:spacing w:after="120" w:line="300"/></w:pPr>'

/** CSL citation schema identifier embedded in every citation field. */
const CSL_CITATION_SCHEMA = 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'

/** Default CSL style used when the caller names none. */
export const DEFAULT_STYLE = 'http://www.zotero.org/styles/ieee'

/** Matches one run that holds a placeholder. */
const RUN_TEMPLATE = token => new RegExp(`<w:r\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?\\{\\{${token}\\}\\}(?:(?!</w:r>)[\\s\\S])*?</w:r>`, 'g')

/** Matches the paragraph that holds the bibliography placeholder. */
const BIB_PARAGRAPH = /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?\{\{BIB\}\}(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/

/** Matches any placeholder that survived injection. */
export const LEFTOVER_PLACEHOLDER = /\{\{Z[^}]*\}\}|\{\{BIB\}\}/g

/**
 * Escape text for an XML text node.
 * @param {string} text - raw text.
 * @returns {string} escaped text.
 */
function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape text for a double-quoted XML attribute.
 * @param {string} text - raw text.
 * @returns {string} escaped attribute value.
 */
function escapeAttribute(text) {
  return escapeXml(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Build the field runs of one citation.
 * @param {string} display - text Word shows until Zotero refreshes the field.
 * @param {object[]} citationItems - `{id, uris, itemData}` entries in citation order.
 * @returns {string} the field XML.
 */
function citationFieldXml(display, citationItems) {
  const payload = {
    citationID: randomBytes(5).toString('hex').toUpperCase(),
    properties: { formattedCitation: display, plainCitation: display, noteIndex: 0 },
    citationItems,
    schema: CSL_CITATION_SCHEMA,
  }
  const instruction = ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(payload)} `
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve">${escapeXml(instruction)}</w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    `<w:r>${RPR}<w:t xml:space="preserve">${escapeXml(display)}</w:t></w:r>`,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join('')
}

/**
 * Build the bibliography field paragraphs.
 * @param {string[]} entries - formatted bibliography entries, in numbering order.
 * @returns {string} one or more `<w:p>` elements.
 */
function bibliographyFieldXml(entries) {
  const instruction = ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY '
  const head = [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve">${escapeXml(instruction)}</w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
  ].join('')
  const paragraph = text => `<w:p>${BIB_PPR}${text}</w:p>`
  const textRun = text => `<w:r>${RPR}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
  if (entries.length === 0) {
    return [`<w:p>${BIB_PPR}${head}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`].join('')
  }
  const parts = [paragraph(`${head}${textRun(entries[0])}`)]
  for (const entry of entries.slice(1, -1)) parts.push(paragraph(textRun(entry)))
  const last = entries.length > 1 ? entries.at(-1) : undefined
  if (last !== undefined) parts.push(paragraph(`${textRun(last)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`))
  else parts[0] = paragraph(`${head}${textRun(entries[0])}<w:r><w:fldChar w:fldCharType="end"/></w:r>`)
  return parts.join('')
}

/**
 * Format one bibliography entry in the shape IEEE numbering expects, including the fields the
 * caller supplied in the CSL record.
 * @param {object} csl - CSL JSON record.
 * @param {number} number - citation number.
 * @returns {string} one bibliography line.
 */
export function formatBibliographyEntry(csl, number) {
  const authors = Array.isArray(csl?.author) ? csl.author : []
  const names = authors.slice(0, 3).map(author => {
    const family = String(author?.family ?? author?.literal ?? '')
    const given = String(author?.given ?? '')
    return family === '' ? given : (given === '' ? family : `${family}, ${given}`)
  })
  const authorText = authors.length > 3 ? [...names, 'et al.'].join('; ') : names.join('; ')
  const title = String(csl?.title ?? '').replace(/<[^>]*>/g, '').trim()
  const year = String(csl?.issued?.['date-parts']?.[0]?.[0] ?? '')
  const journal = String(csl?.['container-title'] ?? '').trim()
  const volume = String(csl?.volume ?? '')
  const issue = String(csl?.issue ?? '')
  const pages = String(csl?.page ?? '')
  const doi = String(csl?.DOI ?? '')
  const head = `[${number}] ${authorText}`.trim()
  const headWithStop = head.endsWith('.') ? head : `${head}.`
  const locator = [journal === '' ? year : `${journal} ${year}`.trim()]
  if (volume !== '') locator.push(`vol. ${volume}`)
  if (issue !== '') locator.push(`no. ${issue}`)
  if (pages !== '') locator.push(`pp. ${pages}`)
  if (doi !== '') locator.push(`doi: ${doi}`)
  const segments = [headWithStop]
  if (title !== '') segments.push(`${title}.`)
  const location = locator.filter(part => part !== '').join(', ')
  if (location !== '') segments.push(`${location}.`)
  return segments.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Build the `ZOTERO_PREF` document variable that tells the Word add-in which style the fields use.
 * @param {string} styleId - CSL style identifier.
 * @returns {string} the `<w:docVar>` element.
 */
export function zoteroPrefDocVar(styleId) {
  const session = randomBytes(5).toString('hex').toUpperCase()
  const value = `<data data-version="3" zotero-version="7.0.22"><session id="${session}"/><style id="${styleId}" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/></prefs></data>`
  return `<w:docVar w:name="ZOTERO_PREF" w:val="${escapeAttribute(value)}"/>`
}

/**
 * Insert or replace the `ZOTERO_PREF` document variable in `settings.xml`.
 * @param {string} settingsXml - current settings part.
 * @param {string} styleId - CSL style identifier.
 * @returns {string} updated settings part.
 */
export function applyZoteroPref(settingsXml, styleId) {
  const docVar = zoteroPrefDocVar(styleId)
  if (/<w:docVars\b[^>]*\/>/.test(settingsXml)) {
    return settingsXml.replace(/<w:docVars\b[^>]*\/>/, `<w:docVars>${docVar}</w:docVars>`)
  }
  if (/<w:docVars\b[^>]*>[\s\S]*?<\/w:docVars>/.test(settingsXml)) {
    const withoutOld = settingsXml.replace(/<w:docVar w:name="ZOTERO_PREF"[^>]*\/>/g, '')
    return withoutOld.replace(/(<w:docVars\b[^>]*>)/, `$1${docVar}`)
  }
  if (settingsXml.includes('</w:settings>')) {
    return settingsXml.replace('</w:settings>', `<w:docVars>${docVar}</w:docVars></w:settings>`)
  }
  throw new Error('Unsupported settings.xml: no w:settings element to hold the ZOTERO_PREF document variable.')
}

/**
 * Read a .docx package into its parts.
 * @param {string} docxPath - absolute path of the document.
 * @returns {Promise<{entries: {name: string, method: number, time: number, date: number, data: Buffer}[], documentXml: string, settingsXml: string}>}
 * the package entries and the two rewritten parts.
 */
export async function readDocx(docxPath) {
  const entries = readZip(await readFile(docxPath))
  const document = entries.find(entry => entry.name === 'word/document.xml')
  if (document === undefined) throw new Error(`Not a Word document: ${docxPath} has no word/document.xml`)
  const settings = entries.find(entry => entry.name === 'word/settings.xml')
  if (settings === undefined) throw new Error(`Not a Word document: ${docxPath} has no word/settings.xml`)
  return { entries, documentXml: document.data.toString('utf8'), settingsXml: settings.data.toString('utf8') }
}

/**
 * Write a .docx package with two replaced parts, keeping every other part as it was.
 * @param {string} outPath - destination path.
 * @param {object[]} entries - package entries from {@link readDocx}.
 * @param {object} parts - replacement text for `documentXml` and/or `settingsXml`.
 * @returns {Promise<void>} resolves once the file is written.
 */
export async function writeDocx(outPath, entries, parts) {
  const updated = entries.map(entry => {
    if (entry.name === 'word/document.xml' && parts.documentXml !== undefined) {
      return { ...entry, data: Buffer.from(parts.documentXml, 'utf8') }
    }
    if (entry.name === 'word/settings.xml' && parts.settingsXml !== undefined) {
      return { ...entry, data: Buffer.from(parts.settingsXml, 'utf8') }
    }
    return entry
  })
  await writeFile(outPath, writeZip(updated))
}

/**
 * Parse a `Z1=KEY1;Z1,2=KEY2|KEY3` mapping string.
 * @param {string} mapping - semicolon-separated assignments.
 * @returns {Map<string, string[]>} placeholder token to item keys, in citation order.
 */
export function parseMapping(mapping) {
  const result = new Map()
  for (const chunk of String(mapping).split(';')) {
    const trimmed = chunk.trim()
    if (trimmed === '') continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) throw new Error(`Invalid mapping entry "${trimmed}": expected TOKEN=KEY or TOKEN=KEY|KEY.`)
    const token = trimmed.slice(0, equals).trim().replace(/^\{\{|\}\}$/g, '')
    const keys = trimmed.slice(equals + 1).split('|').map(key => key.trim()).filter(key => key !== '')
    if (keys.length === 0) throw new Error(`Invalid mapping entry "${trimmed}": no item key after "=".`)
    result.set(token, keys)
  }
  if (result.size === 0) throw new Error('The mapping is empty: expected entries such as "Z1=ABCD1234".')
  return result
}

/**
 * Derive the citation text Word shows before Zotero refreshes, e.g. `[1], [2]`.
 * @param {string} token - placeholder token without braces, such as `Z1,2`.
 * @returns {string} the display text.
 */
export function defaultDisplay(token) {
  const numbers = String(token).split(',').map(part => part.replace(/^Z/, '').trim()).filter(part => part !== '')
  if (numbers.length === 0) return `[${String(token)}]`
  return numbers.map(number => `[${number}]`).join(', ')
}

/**
 * Inject citation and bibliography fields into a document.
 * @param {object} options - injection options.
 * @param {string} options.documentXml - original `word/document.xml`.
 * @param {Map<string, string[]>} options.mapping - placeholder token to item keys.
 * @param {Map<string, object>} options.cslItems - item key to CSL record.
 * @param {string} options.localUserKey - library's local user key, used to build item URIs.
 * @param {object} [options.displays] - explicit display text per token.
 * @param {string[]} [options.bibEntries] - pre-formatted bibliography entries.
 * @param {boolean} [options.bibliography] - emit the bibliography field; defaults to true.
 * @returns {{documentXml: string, citations: object[], bibEntryCount: number, leftover: string[], missingMarkers: string[]}}
 * the updated document part and what was written.
 */
export function injectCitations({ documentXml, mapping, cslItems, localUserKey, displays, bibEntries, bibliography = true }) {
  let xml = documentXml
  const citations = []
  const ordered = [...mapping.entries()].sort((left, right) => right[0].length - left[0].length)
  const citedInOrder = []
  const missingMarkers = []

  for (const [token, keys] of ordered) {
    const citationItems = []
    for (const key of keys) {
      const csl = cslItems.get(key)
      if (csl === undefined) throw new Error(`Item ${key} is not in the CSL export; re-run the CSL export for every mapped key.`)
      const uri = `http://zotero.org/users/local/${localUserKey}/items/${key}`
      citationItems.push({ id: uri, uris: [uri], itemData: csl })
      if (!citedInOrder.includes(key)) citedInOrder.push(key)
    }
    const display = displays?.[token] ?? defaultDisplay(token)
    const field = citationFieldXml(display, citationItems)
    const pattern = RUN_TEMPLATE(token)
    let replaced = 0
    xml = xml.replace(pattern, () => {
      replaced++
      return field
    })
    if (replaced === 0) missingMarkers.push(token)
    citations.push({ token, keys, display, occurrences: replaced })
  }

  let bibEntryCount = 0
  if (bibliography) {
    const entries = bibEntries ?? citedInOrder.map((key, index) => formatBibliographyEntry(cslItems.get(key), index + 1))
    bibEntryCount = entries.length
    const bibField = bibliographyFieldXml(entries)
    if (BIB_PARAGRAPH.test(xml)) {
      xml = xml.replace(BIB_PARAGRAPH, bibField)
    } else {
      const sectionIndex = xml.lastIndexOf('<w:sectPr')
      if (sectionIndex >= 0) xml = `${xml.slice(0, sectionIndex)}${bibField}${xml.slice(sectionIndex)}`
      else xml = xml.replace('</w:body>', `${bibField}</w:body>`)
    }
  }

  return { documentXml: xml, citations, bibEntryCount, leftover: xml.match(LEFTOVER_PLACEHOLDER) ?? [], missingMarkers }
}

/**
 * Count the Zotero fields of a document part.
 * @param {string} xml - `word/document.xml`.
 * @returns {{citationFields: number, bibliographyFields: number, begins: number, ends: number}} field counts.
 */
export function countFields(xml) {
  const count = pattern => (xml.match(pattern) ?? []).length
  return {
    citationFields: count(/ADDIN ZOTERO_ITEM CSL_CITATION/g),
    bibliographyFields: count(/ADDIN ZOTERO_BIBL/g),
    begins: count(/<w:fldChar w:fldCharType="begin"\/>/g),
    ends: count(/<w:fldChar w:fldCharType="end"\/>/g),
  }
}
