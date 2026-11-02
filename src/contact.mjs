/**
 * 联系人解析。
 *
 * 表名不是明文的：每张消息表叫 Msg_<md5(username)>。
 * 所以反查要走两步：先 md5 所有候选 username，对上表名后缀；
 * 再拿 username 去 contact 表取备注名、昵称、微信号。
 *
 * 另一个坑：分片库里 Name2Id 是各自独立的，
 * shard 4/5/6 各有一份自己的 rowid -> username 映射，不能混用。
 */
import { createHash } from 'node:crypto'

export function md5(s) {
  return createHash('md5').update(s, 'utf8').digest('hex')
}

export function tableNameOf(username) {
  return `Msg_${md5(username)}`
}

export function usernameOfTable(tableName) {
  const m = /^Msg_([0-9a-f]{32})$/.exec(tableName)
  return m ? m[1] : null
}

/** 读 contact 表，建 username -> 资料 的映射 */
export function readContacts(db) {
  const map = new Map()
  const rows = db.prepare('select username, alias, remark, nick_name from contact').all()
  for (const r of rows) {
    map.set(String(r.username), {
      username: String(r.username),
      alias: r.alias || '',
      remark: r.remark || '',
      nick: r.nick_name || '',
    })
  }
  return map
}

/** 展示名优先级：备注 > 昵称 > 微信号 */
export function displayName(contact, fallback) {
  if (!contact) return fallback
  return contact.remark || contact.nick || contact.alias || fallback
}

/**
 * 用消息表名反查联系人。
 * 数据量小（几百个联系人）时直接穷举 md5 就够，比查内存快照稳。
 */
export function resolveTableOwner(tableName, contacts) {
  const hex = usernameOfTable(tableName)
  if (!hex) return null
  for (const [username, info] of contacts) {
    if (md5(username) === hex) return { username, ...info }
  }
  return null
}
