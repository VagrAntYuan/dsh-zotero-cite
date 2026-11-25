import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32, readZip, writeZip } from '../lib/zip.js'

test('crc32 matches the zlib polynomial for a known payload', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('writeZip and readZip round-trip stored and deflated entries', () => {
  const entries = [
    { name: 'word/document.xml', method: 8, time: 0, date: 0x21, data: Buffer.from('<w:document/>'.repeat(20)) },
    { name: '[Content_Types].xml', method: 0, time: 0, date: 0x21, data: Buffer.from('<Types/>') },
  ]
  const archive = writeZip(entries)
  const restored = readZip(archive)
  assert.deepEqual(restored.map(entry => entry.name), ['word/document.xml', '[Content_Types].xml'])
  assert.equal(restored[0].data.toString('utf8'), entries[0].data.toString('utf8'))
  assert.equal(restored[1].data.toString('utf8'), entries[1].data.toString('utf8'))
  assert.equal(restored[0].method, 8)
})

test('readZip keeps UTF-8 part names intact', () => {
  const archive = writeZip([
    { name: 'word/文档.xml', method: 8, time: 0, date: 0x21, data: Buffer.from('x') },
  ])
  assert.equal(readZip(archive)[0].name, 'word/文档.xml')
})
