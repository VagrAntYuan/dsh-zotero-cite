/**
 * Build the citation review report: where every citation sits, what sentence carries it, and a
 * per-reference table a reviewer fills with 合理 / 存疑 / 不合理 after checking the source PDF.
 * The report is a Markdown checklist, not a judgement — the model does the judging.
 * @module dsh-zotero-cite/lib/review
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Matches one body paragraph. */
const PARAGRAPH = /<w:p\b[^>]*>((?:(?!<\/w:p>)[\s\S])*?)<\/w:p>/g

/** Matches a citation placeholder inside paragraph text. */
const CITATION_TOKEN = /\{\{(Z[\d, ]+)\}\}/g

/** Section names that end the citing part of a thesis. */
const BACK_MATTER = new Set(['参考文献', 'References', 'REFERENCES'])

/**
 * Decode the XML entities Word writes into text nodes.
 * @param {string} text - escaped text.
 * @returns {string} decoded text.
 */
function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/**
 * Read the visible paragraphs of a document part, with the style each one uses.
 * @param {string} documentXml - `word/document.xml`.
 * @returns {{text: string, styleId: string, numbered: boolean, isHeading: boolean}[]} paragraphs in
 * document order.
 */
export function extractParagraphs(documentXml) {
  const paragraphs = []
  for (const match of documentXml.matchAll(PARAGRAPH)) {
    const body = match[1] ?? ''
    if (body === '') continue
    const text = decodeXml(
      [...body.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(part => part[1]).join(''),
    ).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const styleId = /<w:pStyle w:val="([^"]+)"/.exec(body)?.[1] ?? ''
    const numbered = /<w:numPr>/.test(body)
    paragraphs.push({ text, styleId, numbered, isHeading: isHeading(text, styleId, numbered) })
  }
  return paragraphs
}

/**
 * Decide whether a paragraph opens a section.
 * @param {string} text - paragraph text.
 * @param {string} styleId - paragraph style id.
 * @param {boolean} numbered - whether the paragraph carries list numbering.
 * @returns {boolean} true for headings.
 */
function isHeading(text, styleId, numbered) {
  if (/^(heading\s*\d|标题\s*\d|title)$/i.test(styleId)) return true
  if (/^(参考文献|摘要|关键词|abstract|keywords|references)$/i.test(text)) return true
  return numbered && text.length <= 60
}

/**
 * Split one paragraph into sentences so a reviewer sees the citing clause only.
 * @param {string} text - paragraph text.
 * @returns {string[]} sentences, empty entries removed.
 */
export function splitSentences(text) {
  return String(text)
    .split(/(?<=[。；！？.!?;])/)
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * Collect every citation occurrence in document order.
 * @param {{text: string, isHeading: boolean}[]} paragraphs - paragraphs from {@link extractParagraphs}.
 * @returns {{key: string, token: string, section: string, snippet: string, paragraph: number}[]} occurrences.
 */
export function collectCitations(paragraphs) {
  const occurrences = []
  let section = '(开头)'
  let stop = false
  for (const [index, paragraph] of paragraphs.entries()) {
    if (BACK_MATTER.has(paragraph.text.trim())) {
      stop = true
      break
    }
    if (paragraph.isHeading) {
      section = paragraph.text.slice(0, 60)
      continue
    }
    const tokens = [...paragraph.text.matchAll(CITATION_TOKEN)]
    if (tokens.length === 0) continue
    const sentences = splitSentences(paragraph.text)
    for (const [order, token] of tokens.entries()) {
      const raw = token[0]
      const snippet = sentences.find(sentence => sentence.includes(raw)) ?? paragraph.text
      occurrences.push({
        key: token[1],
        token: raw,
        section,
        snippet: snippet.slice(0, 160),
        paragraph: index,
      })
    }
  }
  if (!stop) section = section === '(开头)' ? '(全文)' : section
  return occurrences
}

/**
 * Render one review table.
 * @param {string} key - the placeholder token number, such as `Z1`.
 * @param {object} csl - CSL record for the cited item.
 * @param {object[]} occurrences - occurrences of that token.
 * @returns {string[]} Markdown lines.
 */
function renderSourceSection(key, csl, occurrences, itemKeys) {
  const authors = (Array.isArray(csl?.author) ? csl.author : [])
    .slice(0, 2)
    .map(author => String(author?.family ?? author?.literal ?? ''))
    .filter(name => name !== '')
  const year = String(csl?.issued?.['date-parts']?.[0]?.[0] ?? '')
  const title = String(csl?.title ?? '')
  const lines = [`### ${key} — ${authors.join('; ')}${year === '' ? '' : `, ${year}`}：《${title}》`, '']
  if (itemKeys.length > 0) lines.push(`- Zotero 条目：${itemKeys.map(itemKey => `\`${itemKey}\``).join(', ')}`)
  if (csl === undefined) lines.push('- 未找到该占位符对应的 CSL 记录，请检查映射与 csl_items.json。')
  lines.push('')
  lines.push('| # | 位置 | 引用语句 | 判断 | 备注 |')
  lines.push('|---|---|---|---|---|')
  for (const [index, occurrence] of occurrences.entries()) {
    const snippet = occurrence.snippet.replace(/\|/g, '\\|')
    const section = occurrence.section.replace(/\|/g, '\\|')
    lines.push(`| ${index + 1} | ${section} | ${snippet} | 待审 | |`)
  }
  lines.push('')
  return lines
}

/**
 * Build the review report.
 * @param {object} options - report options.
 * @param {object[]} options.occurrences - citations from {@link collectCitations}.
 * @param {Map<string, string[]>} options.mapping - placeholder token such as `Z1` to item keys.
 * @param {Map<string, object>} options.cslItems - item key to CSL record.
 * @param {string} options.documentName - file name shown in the report title.
 * @param {boolean} [options.checklist] - include the automatic coverage checks.
 * @returns {string} Markdown report.
 */
export function buildReviewReport({ occurrences, mapping, cslItems, documentName, checklist = false }) {
  const groups = new Map()
  for (const occurrence of occurrences) {
    const group = groups.get(occurrence.key) ?? []
    group.push(occurrence)
    groups.set(occurrence.key, group)
  }
  const keysOf = token => mapping.get(token) ?? []
  const lines = ['# 引用合理性报告（自动生成模板）', '']
  lines.push(`- 文档：${documentName}`)
  lines.push(`- 引用实例总数：${occurrences.length}`)
  lines.push(`- 不同引用编号：${groups.size}`)
  lines.push('')
  if (checklist) {
    lines.push('## 自动检查', '')
    const cited = new Set([...groups.keys()].flatMap(token => keysOf(token)))
    const uncited = [...cslItems.keys()].filter(itemKey => !cited.has(itemKey))
    lines.push(`- 覆盖检查：${uncited.length === 0 ? '所有导出条目都在正文中被引用。' : `导出但未在正文引用的条目：${uncited.join(', ')}`}`)
    const unmapped = [...groups.keys()].filter(token => keysOf(token).length === 0)
    if (unmapped.length > 0) lines.push(`- 映射缺失：${unmapped.join(', ')} 在 csl_items.json 中没有对应条目。`)
    const sections = new Map()
    for (const occurrence of occurrences) sections.set(occurrence.section, (sections.get(occurrence.section) ?? 0) + 1)
    lines.push(`- 引用分布：${[...sections].map(([section, count]) => `${section}(${count})`).join('；') || '无'}`)
    lines.push('')
  }
  lines.push('## 逐篇审查', '')
  lines.push('按引用编号分组，每行给出所在章节与引用语句。逐条对照原文后，在"判断"列填写 合理 / 存疑 / 不合理，并在"备注"列写明依据。', '')
  const ordered = [...groups.entries()].sort((left, right) => Number(left[0].replace(/\D/g, '')) - Number(right[0].replace(/\D/g, '')))
  for (const [token, group] of ordered) {
    const itemKeys = keysOf(token)
    const csl = itemKeys.map(itemKey => cslItems.get(itemKey)).find(record => record !== undefined)
    lines.push(...renderSourceSection(token, csl, group, itemKeys))
  }
  lines.push('## 使用说明', '')
  lines.push('1. 打开每篇被引文献的 PDF，核对引用语句是否真的支持该处论断。')
  lines.push('2. 在"判断"列填写 合理 / 存疑 / 不合理；存疑与不合理必须在备注里写明原因。')
  lines.push('3. 语义不符、张冠李戴、过度引用的条目，回到正文修改表述或更换文献。')
  lines.push('4. 填完的表即为交付的引用合理性报告。')
  lines.push('')
  return lines.join('\n')
}

/**
 * Write the review report next to the document's work directory.
 * @param {object} options - write options.
 * @param {string} options.workDir - destination directory.
 * @param {string} options.documentName - file name shown in the title.
 * @param {object[]} options.occurrences - citations to report.
 * @param {Map<string, string[]>} options.mapping - placeholder token to item keys.
 * @param {Map<string, object>} options.cslItems - item key to CSL record.
 * @param {boolean} [options.checklist] - include automatic checks.
 * @returns {Promise<{reportPath: string, citations: number, sources: number}>} written report details.
 */
export async function writeReviewReport({ workDir, documentName, occurrences, mapping, cslItems, checklist = false }) {
  const markdown = buildReviewReport({ occurrences, mapping, cslItems, documentName, checklist })
  await mkdir(workDir, { recursive: true })
  const reportPath = path.join(workDir, 'citation_review_report.md')
  await writeFile(reportPath, markdown, 'utf8')
  return { reportPath, citations: occurrences.length, sources: new Set(occurrences.map(item => item.key)).size }
}
