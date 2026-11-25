import assert from 'node:assert/strict'
import test from 'node:test'
import { filenameYear, planImports, scoreMatch, tokenize } from '../lib/import.js'
import { findDuplicateGroups, fingerprint, normDoi, normTitle } from '../lib/merge.js'
import { buildReviewReport, collectCitations, extractParagraphs, splitSentences } from '../lib/review.js'

/** Build a library item. */
const item = (key, data, numChildren = 0) => ({ key, data: { key, ...data }, meta: { numChildren } })

const PDF_NAME = 'Vaswani 2017 Attention is all you need.pdf'

test('tokenize drops stopwords and one-letter tokens', () => {
  assert.deepEqual(tokenize('Est. Vaswani 2017 - Attention, is all you need'), ['vaswani', 'attention', 'is', 'all', 'you', 'need'])
  assert.deepEqual(tokenize('PDF Review research'), [])
})

test('filenameYear finds the publication year in a PDF file name', () => {
  assert.equal(filenameYear(PDF_NAME), 2017)
  assert.equal(filenameYear('report-20215-draft.pdf'), undefined)
})

test('scoreMatch resolves an item by first-author surname and year', () => {
  const vaswani = item('ABCD1234', {
    itemType: 'journalArticle',
    title: 'Attention is all you need',
    date: '2017-06-12 2017',
    creators: [{ firstName: 'Ashish', lastName: 'Vaswani', creatorType: 'author' }],
  })
  const other = item('ZZZZ9999', {
    itemType: 'journalArticle',
    title: 'Unrelated',
    date: '2019',
    creators: [{ firstName: 'Ann', lastName: 'Other', creatorType: 'author' }],
  })
  const pool = [vaswani, other]
  const scored = scoreMatch(PDF_NAME, vaswani)
  assert.equal(scored.strong, true)
  assert.equal(scoreMatch(PDF_NAME, other).strong, false)
  assert.equal(pool.length, 2)
})

test('planImports marks existing, matched, and unknown files', () => {
  const items = [
    item('ABCD1234', {
      itemType: 'journalArticle',
      title: 'Attention is all you need',
      date: '2017',
      creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }],
    }),
  ]
  const files = [
    { name: 'Vaswani 2017 Attention is all you need.pdf', path: 'C:\\papers\\a.pdf' },
    { name: 'unknown-paper-1999.pdf', path: 'C:\\papers\\b.pdf' },
    { name: 'known.pdf', path: 'C:\\papers\\c.pdf' },
  ]
  const attachments = new Map([['known.pdf', 'KNWN0001']])
  const plans = planImports({ files, items, attachments })
  assert.deepEqual(plans.map(plan => plan.status), ['matched', 'unmatched', 'existing'])
  assert.equal(plans[0].key, 'ABCD1234')
  assert.equal(plans[2].key, 'KNWN0001')
})

test('normalization folds DOI and title variants onto one fingerprint', () => {
  assert.equal(normDoi('https://doi.org/10.5555/ABC.123.'), '10.5555/abc.123')
  assert.equal(normTitle('Attention Is All You <i>Need</i>'), 'attentionisallyouneed')
  const left = item('AAAA1111', { itemType: 'journalArticle', title: 'Attention Is All You Need', DOI: '10.5555/abc' })
  const right = item('BBBB2222', { itemType: 'journalArticle', title: 'attention is all you need', DOI: 'https://doi.org/10.5555/abc' })
  assert.equal(fingerprint(left), fingerprint(right))
})

test('findDuplicateGroups keeps the more complete duplicate as the target', () => {
  const sparse = item('AAAA1111', { itemType: 'journalArticle', title: 'Attention Is All You Need', DOI: '10.5555/abc', dateAdded: '2020-01-01' })
  const rich = item(
    'BBBB2222',
    {
      itemType: 'journalArticle',
      title: 'Attention Is All You Need',
      DOI: '10.5555/abc',
      dateAdded: '2021-01-01',
      creators: [{ lastName: 'Vaswani' }, { lastName: 'Shazeer' }],
    },
    2,
  )
  const groups = findDuplicateGroups([sparse, rich])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].target, 'BBBB2222')
  assert.equal(groups[0].members.length, 2)
})

test('findDuplicateGroups prefers a cited copy', () => {
  const left = item('AAAA1111', { itemType: 'journalArticle', title: 'Attention Is All You Need' })
  const right = item('BBBB2222', { itemType: 'journalArticle', title: 'Attention Is All You Need' })
  const groups = findDuplicateGroups([left, right], new Set(['AAAA1111']))
  assert.equal(groups[0].target, 'AAAA1111')
})

test('splitSentences keeps Chinese and Latin terminators', () => {
  assert.deepEqual(splitSentences('第一句。第二句；Third one. Fourth'),
    ['第一句。', '第二句；', 'Third one.', 'Fourth'])
})

test('collectCitations records section, sentence, and token', () => {
  const documentXml =
    '<w:document><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>1 引言</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>卷积网络很慢{{Z1}}。这里给出第二个论断{{Z2}}。</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>合并引用{{Z1,2}}。</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>参考文献</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>{{Z9}}</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  const paragraphs = extractParagraphs(documentXml)
  assert.equal(paragraphs[0].isHeading, true)
  const occurrences = collectCitations(paragraphs)
  assert.deepEqual(occurrences.map(occurrence => occurrence.key), ['Z1', 'Z2', 'Z1,2'])
  assert.equal(occurrences[0].section, '1 引言')
  assert.equal(occurrences[0].snippet, '卷积网络很慢{{Z1}}。')
})

test('buildReviewReport groups by placeholder and links item keys', () => {
  const report = buildReviewReport({
    documentName: 'draft.docx',
    occurrences: [
      { key: 'Z1', token: '{{Z1}}', section: '1 引言', snippet: '甲{{Z1}}。', paragraph: 1 },
      { key: 'Z1', token: '{{Z1}}', section: '3 方法', snippet: '乙{{Z1}}。', paragraph: 5 },
    ],
    mapping: new Map([['Z1', ['ABCD1234']]]),
    cslItems: new Map([[
      'ABCD1234',
      { title: 'Attention is all you need', author: [{ family: 'Vaswani' }], issued: { 'date-parts': [[2017]] } },
    ]]),
    checklist: true,
  })
  assert.match(report, /# 引用合理性报告/)
  assert.match(report, /### Z1 — Vaswani, 2017：《Attention is all you need》/)
  assert.match(report, /`ABCD1234`/)
  assert.match(report, /\| 1 \| 1 引言 \| 甲\{\{Z1\}\}。 \| 待审 \|/)
  assert.match(report, /覆盖检查：所有导出条目都在正文中被引用。/)
})
