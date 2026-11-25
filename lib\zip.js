/**
 * Minimal ZIP reader and writer used by the Word (.docx) field injection and the citation
 * report reader. Only what OOXML packages need: stored and deflated entries, no encryption,
 * no ZIP64. Every entry other than the ones being rewritten is copied through byte-for-byte
 * after a re-inflate, so a document keeps its media, styles, and unknown parts intact.
 * @module dsh-zotero-cite/lib/zip
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50

/** CRC-32 lookup table for the ZIP entry checksums. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

/**
 * Compute the ZIP CRC-32 of a buffer.
 * @param {Buffer} buffer - bytes to checksum.
 * @returns {number} unsigned 32-bit checksum.
 */
export function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/**
 * Read every entry of a ZIP archive.
 * @param {Buffer} archive - complete archive bytes.
 * @returns {{name: string, method: number, time: number, date: number, data: Buffer}[]} entries in
 * central-directory order, each already decompressed.
 */
export function readZip(archive) {
  const eocd = findEndOfCentralDirectory(archive)
  const count = archive.readUInt16LE(eocd + 10)
  let cursor = archive.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error(`corrupt ZIP: central directory entry ${index} has a bad signature`)
    }
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const time = archive.readUInt16LE(cursor + 12)
    const date = archive.readUInt16LE(cursor + 14)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (flags & 0x1) throw new Error(`unsupported ZIP entry "${name}": encrypted`)
    if (archive.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new Error(`corrupt ZIP: local header for "${name}" has a bad signature`)
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = archive.subarray(start, start + compressedSize)
    entries.push({ name, method, time, date, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) })
  }
  return entries
}

/**
 * Build a ZIP archive from entries.
 * @param {{name: string, method?: number, time?: number, date?: number, data: Buffer}[]} entries - files
 * to write in order; `method` 8 deflates, 0 stores.
 * @returns {Buffer} complete archive bytes.
 */
export function writeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const deflated = entry.method === 0 ? data : deflateRawSync(data)
    const useDeflate = entry.method !== 0 && deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const flags = /[^\u0000-\u007F]/.test(entry.name) ? 0x0800 : 0
    const time = entry.time ?? 0
    const date = entry.date ?? 0x21
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + payload.length
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * Locate the end-of-central-directory record, scanning back over an optional archive comment.
 * @param {Buffer} archive - complete archive bytes.
 * @returns {number} byte offset of the record.
 */
function findEndOfCentralDirectory(archive) {
  const floor = Math.max(0, archive.length - 66_000)
  for (let index = archive.length - 22; index >= floor; index--) {
    if (archive.readUInt32LE(index) === END_OF_CENTRAL) return index
  }
  throw new Error('not a ZIP archive: end-of-central-directory record not found')
}
