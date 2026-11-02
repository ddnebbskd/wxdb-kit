/**
 * 打开解密后的库，并把 WCDB 的字段编码解回文本。
 *
 * WCDB 会对长文本做 zstd 压缩，压缩过的字段会在 WCDB_CT_message_content
 * 里标 4（CT_ZSTD）；也见过标记没跟上、但内容以 zstd 魔数开头的行，
 * 所以判断条件要两条一起看。
 */
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'

export const CT_ZSTD = 4
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

export function openDb(path) {
  return new DatabaseSync(path, { readOnly: true })
}

function looksZstd(buf) {
  return buf.length > 3 && ZSTD_MAGIC.every((b, i) => buf[i] === b)
}

/** 把 BLOB 字段解成字符串；失败返回空串，不抛 */
export function decodeField(value, compressType) {
  if (value == null) return ''
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (!raw.length) return ''
  if (compressType === CT_ZSTD || looksZstd(raw)) {
    try {
      return zstdDecompressSync(raw).toString('utf8')
    } catch {
      /* 解不开就当普通文本处理 */
    }
  }
  return raw.toString('utf8')
}

/** 列表所有 Msg_ 表 */
export function listMessageTables(db) {
  return db
    .prepare("select name from sqlite_master where type='table' and name like 'Msg\\_%' escape '\\' order by name")
    .all()
    .map((r) => r.name)
}

/** 读 Name2Id：rowid -> user_name */
export function name2id(db) {
  const map = new Map()
  for (const r of db.prepare('select rowid as rid, user_name from Name2Id').all()) {
    map.set(Number(r.rid), String(r.user_name))
  }
  return map
}

/** 读会话表（session 库） */
export function readSessions(db) {
  return db
    .prepare('select username, type, unread_count, summary, last_timestamp from SessionTable order by last_timestamp desc')
    .all()
    .map((r) => ({
      username: r.username,
      type: Number(r.type),
      unread: Number(r.unread_count || 0),
      summary: r.summary || '',
      lastTs: Number(r.last_timestamp || 0),
    }))
}
