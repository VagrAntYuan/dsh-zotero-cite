import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_STYLE,
  applyZoteroPref,
  countFields,
  defaultDisplay,
  formatBibliographyEntry,
  injectCitations,
  parseMapping,
} from '../lib/docx.js'

/** One CSL record shaped like Zotero's local export. */
const CSL = {
  id: 'http://zotero.org/users/local/iTQ16ppd/items/ABCD1234',
  type: 'article-journal',
  title: 'Attention is all you need',
  author: [
    { family: 'Vaswani', given: 'Ashish' },
    { family: 'Shazeer', given: 'Noam' },
    { family: 'Parmar', given: 'Niki' },
    { family: 'Uszkoreit', given: 'Jakob' },
  ],
  issued: { 'date-parts': [[2017]] },
  'container-title': 'Advances in Neural Information Processing Systems',
  volume: '30',
  page: '5998-6008',
  DOI: '10.5555/3295222.3295349',
}

const SECOND = {
  id: 'http://zotero.org/users/local/iTQ16ppd/items/EFGH5678',
  type: 'book',
  title: 'Designing data-intensive applications',
  author: [{ family: 'Kleppmann', given: 'Martin' }],
  issued: { 'date-parts': [[2017]] },
  publisher: 'O\'Reilly',
}

/**
 * Build a document part with the given body.
 * @param {string} body - `<w:body>` children.
 * @returns {string} a complete document.xml.
 */
const documentXml = body =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`

test('parseMapping accepts groups and several keys per placeholder', () => {
  const mapping = parseMapping('Z1=ABCD1234;Z2=EFGH5678;Z1,2=ABCD1234|EFGH5678')
  assert.deepEqual([...mapping.keys()], ['Z1', 'Z2', 'Z1,2'])
  assert.deepEqual(mapping.get('Z1,2'), ['ABCD1234', 'EFGH5678'])
})

test('parseMapping rejects entries without a key', () => {
  assert.throws(() => parseMapping('Z1'), /expected TOKEN=KEY/)
  assert.throws(() => parseMapping('Z1='), /no item key/)
})

test('defaultDisplay renders one bracket per placeholder number', () => {
  assert.equal(defaultDisplay('Z1'), '[1]')
  assert.equal(defaultDisplay('Z3,4'), '[3], [4]')
})

test('formatBibliographyEntry follows the numbered IEEE shape', () => {
  assert.equal(
    formatBibliographyEntry(CSL, 1),
    '[1] Vaswani, Ashish; Shazeer, Noam; Parmar, Niki; et al. Attention is all you need. Advances in Neural Information Processing Systems 2017, vol. 30, pp. 5998-6008, doi: 10.5555/3295222.3295349.',
  )
  assert.equal(
    formatBibliographyEntry(SECOND, 2),
    '[2] Kleppmann, Martin. Designing data-intensive applications. 2017.',
  )
})

test('injectCitations writes one field per placeholder and one bibliography', () => {
  const mapping = parseMapping('Z1=ABCD1234;Z2=EFGH5678;Z1,2=ABCD1234|EFGH5678')
  const xml = documentXml(
    '<w:p><w:r><w:t>First {{Z1}} claim.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second {{Z2}} claim.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Combined {{Z1,2}} claim.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>{{BIB}}</w:t></w:r></w:p>',
  )
  const result = injectCitations({
    documentXml: xml,
    mapping,
    cslItems: new Map([['ABCD1234', CSL], ['EFGH5678', SECOND]]),
    localUserKey: 'iTQ16ppd',
  })
  const fields = countFields(result.documentXml)
  assert.equal(fields.citationFields, 3)
  assert.equal(fields.bibliographyFields, 1)
  assert.equal(fields.begins, fields.ends)
  assert.deepEqual(result.leftover, [])
  assert.deepEqual(result.missingMarkers, [])
  assert.equal(result.bibEntryCount, 2)
  assert.match(result.documentXml, /http:\/\/zotero\.org\/users\/local\/iTQ16ppd\/items\/ABCD1234/)
  assert.match(result.documentXml, /\[1\], \[2\]/)
  assert.match(result.documentXml, /ADDIN ZOTERO_BIBL \{"uncited":\[\],"omitted":\[\],"custom":\[\]\} CSL_BIBLIOGRAPHY/)
  assert.doesNotMatch(result.documentXml, /\{\{/)
})

test('injectCitations appends the bibliography when the draft has no placeholder', () => {
  const xml = documentXml('<w:p><w:r><w:t>{{Z1}}</w:t></w:r></w:p>')
  const result = injectCitations({
    documentXml: xml,
    mapping: parseMapping('Z1=ABCD1234'),
    cslItems: new Map([['ABCD1234', CSL]]),
    localUserKey: 'iTQ16ppd',
  })
  assert.ok(result.documentXml.includes('CSL_BIBLIOGRAPHY'))
  assert.ok(result.documentXml.indexOf('CSL_BIBLIOGRAPHY') < result.documentXml.indexOf('<w:sectPr'))
  assert.equal(result.leftover.length, 0)
})

test('injectCitations reports placeholders split across runs instead of writing broken fields', () => {
  const xml = documentXml('<w:p><w:r><w:t>{{Z</w:t></w:r><w:r><w:t>1}}</w:t></w:r></w:p>')
  const result = injectCitations({
    documentXml: xml,
    mapping: parseMapping('Z1=ABCD1234'),
    cslItems: new Map([['ABCD1234', CSL]]),
    localUserKey: 'iTQ16ppd',
  })
  assert.deepEqual(result.missingMarkers, ['Z1'])
  assert.equal(countFields(result.documentXml).citationFields, 0)
})

test('injectCitations refuses keys missing from the CSL export', () => {
  assert.throws(
    () =>
      injectCitations({
        documentXml: documentXml('<w:p><w:r><w:t>{{Z9}}</w:t></w:r></w:p>'),
        mapping: parseMapping('Z9=MISSING1'),
        cslItems: new Map(),
        localUserKey: 'iTQ16ppd',
      }),
    /not in the CSL export/,
  )
})

test('applyZoteroPref adds a document variable and keeps one when called twice', () => {
  const settings = '<?xml version="1.0"?><w:settings xmlns:w="x"><w:zoom w:percent="100"/></w:settings>'
  const once = applyZoteroPref(settings, DEFAULT_STYLE)
  assert.match(once, /<w:docVars><w:docVar w:name="ZOTERO_PREF" w:val="/)
  assert.match(once, /fieldType/)
  const twice = applyZoteroPref(once, 'http://www.zotero.org/styles/apa')
  assert.equal((twice.match(/ZOTERO_PREF/g) ?? []).length, 1)
  assert.match(twice, /styles\/apa/)
})
