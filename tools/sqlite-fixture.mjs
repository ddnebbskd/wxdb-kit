/**
 * 构造"像真的一样"的测试库，只给工具脚本用。
 *
 * 生产代码（src/）不依赖这个文件。它解决的问题只有一个：
 * 真实的 WCDB 库每页 4096 字节，最后 80 字节留给 IV 和 HMAC
 * （SQLite 的 reserved space，可用 4016）。node:sqlite 没有提供
 * 设置保留区的接口，所以只能手工改文件头再重开。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'

export const PAGE_SIZE = 4096
export const RESERVE = 80
export const CT_ZSTD = 4

/**
 * 把一个普通 SQLite 库改成"带保留区"的库。
 *
 * 两个值都要改，只改一个会坏：
 *   偏移 20   每页保留字节数
 *   偏移 105  第 1 页 b-tree 头的"单元格内容区起点"
 * 只改 20 的话，SQLite 仍认为内容区从 4096 开始，
 * 打开就报 database disk image is malformed（free space corruption）。
 */
export function patchReserve(path, reserve = RESERVE) {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA page_size = ${PAGE_SIZE};`)
  db.exec('create table __probe(x); drop table __probe;')
  db.close()

  const buf = readFileSync(path)
  const usable = PAGE_SIZE - reserve
  buf[20] = reserve
  buf.writeUInt16BE(usable, 105)
  writeFileSync(path, buf)

  const check = new DatabaseSync(path, { readOnly: true })
  const integrity = check.prepare('PRAGMA integrity_check').all()
  const sizeRow = check.prepare('PRAGMA page_size').get()
  check.close()
  const verdict = String(Object.values(integrity[0] || {})[0] || '')
  if (verdict !== 'ok') throw new Error(`保留区改造后完整性校验失败：${verdict}`)
  return Number(sizeRow.page_size)
}

/** 建一张和真实 Msg_* 表同字段的消息表 */
export function makeMessageTable(db, name) {
  db.exec(`
    create table "${name}" (
      local_id integer primary key,
      server_id integer,
      local_type integer,
      sort_seq integer,
      real_sender_id integer,
      create_time integer,
      status integer,
      message_content blob,
      compress_content blob,
      WCDB_CT_message_content integer
    );
  `)
}

/**
 * 批量插入消息。
 *
 * rows 的元素：{ ts, type, senderId, text, zstd? }
 * - text 为 null 时写 NULL，用来模拟"只有附件、没有正文"的行
 * - 超过 150 字节的正文按真实行为压成 zstd，并把 WCDB_CT 标成 4
 */
export function insertMessages(db, table, rows) {
  const stmt = db.prepare(
    `insert into "${table}"
      (local_id, server_id, local_type, sort_seq, real_sender_id, create_time,
       status, message_content, compress_content, WCDB_CT_message_content)
      values (?, ?, ?, ?, ?, ?, 0, ?, null, ?)`
  )

  let i = 0
  for (const r of rows) {
    i++
    const raw = r.text == null ? null : Buffer.from(String(r.text), 'utf8')
    const compress = raw ? (r.zstd ?? raw.length > 150) : false
    const body = compress ? zstdCompressSync(raw) : raw
    stmt.run(i, 100000 + i, r.type, i, r.senderId, r.ts, body, compress ? CT_ZSTD : 0)
  }
  return i
}
