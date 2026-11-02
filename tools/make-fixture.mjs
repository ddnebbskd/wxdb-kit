/**
 * 生成演示数据。
 *
 * 所有内容都是编的：假账号、假联系人、假对话、假时间。
 * 流程反而跟真实流程一样：先建一个普通 SQLite 库，
 * 再用 sqlcipher.mjs 的加密侧把整库加密成 .db.enc。
 * 这样解密、解析、导出三步都能真跑，仓库里又不含任何真实数据。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { encryptFile } from '../src/sqlcipher.mjs'
import { tableNameOf } from '../src/contact.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'fixture')

// ---- 假身份 ----
const SELF = 'wxid_demo_me'
const FRIEND = 'wxid_demo_alice'
const ROOM = '12345678901@chatroom'

const contacts = [
  { username: SELF, remark: '', nick: '演示号', alias: 'demo_me' },
  { username: FRIEND, remark: '阿岚', nick: '岚酱', alias: 'lan_2024' },
  { username: ROOM, remark: '项目组', nick: '项目组', alias: '' },
]

const p2 = (n) => String(n).padStart(2, '0')
const t = (day, hh, mm, ss = 0) =>
  Math.floor(new Date(`2024-03-${p2(day)}T${p2(hh)}:${p2(mm)}:${p2(ss)}+08:00`).getTime() / 1000)

const APP = (sub) => 49 + sub * 4294967296

function linkXml() {
  return `<msg><appmsg appid="" sdkver="0"><title>一份演示用的链接</title><des>点开也不会有任何东西</des><type>1</type><url>https://example.com/demo</url></appmsg></msg>`
}
function quoteXml() {
  return `<msg><appmsg appid="" sdkver="0"><title>你刚才那句我记下了</title><type>57</type><refermsg><type>1</type><content>这周先把这个跑通</content></refermsg></appmsg></msg>`
}
function transferXml() {
  return `<msg><appmsg appid="wxf0" sdkver="0"><title>转账</title><des>谢谢你请的那杯咖啡</des><type>2000</type><wcpayinfo><feedesc>￥18.00</feedesc></wcpayinfo></appmsg></msg>`
}
function systemXml(text) {
  return `<sysmsg type="revokemsg"><content>${text}</content></sysmsg>`
}

// 一段长文本，用来演示 zstd 压缩字段
const longText = (
  '演示用长文本：' +
  '这一段会被 zstd 压过再存进去，所以必须靠 WCDB_CT 标记或魔数判断才能解回来。'
).repeat(6)

const friendMsgs = [
  [t(1, 9, 12), 1, FRIEND, '早，今天那个库跑通了吗'],
  [t(1, 9, 13), 1, SELF, '跑到一半，页面校验过不去'],
  [t(1, 9, 15), 1, FRIEND, '先看第一页，第一页有 salt'],
  [t(1, 9, 30), 1, SELF, '过了，是我把 0x3a 记成了 0x3b'],
  [t(1, 9, 31), 1, FRIEND, '哈哈，经典'],
  [t(1, 10, 2), 3, FRIEND, ''],
  [t(1, 10, 3), 1, FRIEND, '截图给你看，就是这个报错'],
  [t(1, 10, 20), APP(1), SELF, linkXml()],
  [t(1, 11, 0), 34, FRIEND, ''],
  [t(1, 11, 1), 1, SELF, '听不清，你发字吧'],
  [t(1, 11, 2), 47, FRIEND, ''],
  [t(1, 14, 0), 1, FRIEND, '这周先把这个跑通'],
  [t(1, 14, 5), APP(57), SELF, quoteXml()],
  [t(1, 14, 6), 1, FRIEND, '行，那就这么定'],
  [t(1, 15, 40), 10000, SELF, systemXml('你撤回了一条消息')],
  [t(2, 8, 30), 1, FRIEND, '昨天那个导出脚本我改了，快了一倍'],
  [t(2, 8, 31), 1, SELF, '怎么改的'],
  [t(2, 8, 33), 1, FRIEND, '一次性读 1000 页再写，别一页一页开文件'],
  [t(2, 9, 0), APP(2000), FRIEND, transferXml()],
  [t(2, 9, 1), 1, SELF, '干嘛突然给我转钱'],
  [t(2, 9, 2), 1, FRIEND, '咖啡'],
  [t(2, 20, 15), 43, FRIEND, ''],
  [t(3, 10, 0), 1, FRIEND, '这个 README 我看了，写得挺清楚'],
  [t(3, 10, 1), 1, SELF, '还差一份格式说明'],
  [t(3, 10, 2), 1, FRIEND, '那部分我补，你先把伦理那段写了'],
  [t(3, 10, 5), 1, SELF, longText],
  [t(3, 21, 30), 1, FRIEND, '明天见'],
]

const roomMsgs = [
  [t(1, 9, 0), 1, FRIEND, `${FRIEND}:\n有人吗`],
  [t(1, 9, 2), 1, SELF, '在'],
  [t(1, 9, 3), 1, FRIEND, `${FRIEND}:\n帮忙看个报错`],
  [t(2, 12, 0), 3, FRIEND, ''],
  [t(2, 12, 1), 1, FRIEND, `${FRIEND}:\n中午吃啥`],
]

/**
 * 建一个"带保留区"的 SQLite 库。
 *
 * 真实的 WCDB 库每页 4096 字节，最后 80 字节留空给 IV 和 HMAC，
 * 也就是 SQLite 的 reserved space（usable = 4096 - 80 = 4016）。
 * node:sqlite 没有暴露设置它的接口，但这两个值都写在文件里：
 *   文件头第 20 字节        = 每页保留字节数
 *   第 1 页 b-tree 头 +105  = 单元格内容起始偏移
 * 先建一个空库（schema 为空），把这两处一起改掉再重开，
 * SQLite 就会按 4016 的可用空间重新排版。
 */
function patchReserve(path, reserve = 80) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA page_size = 4096;')
  db.exec('create table __probe(x); drop table __probe;')
  db.close()

  const buf = readFileSync(path)
  const usable = 4096 - reserve
  buf[20] = reserve
  buf.writeUInt16BE(usable, 105) // 第 1 页 b-tree：单元格内容区起点
  writeFileSync(path, buf)

  const check = new DatabaseSync(path, { readOnly: true })
  const integrity = check.prepare('PRAGMA integrity_check').all()
  const pageSize = check.prepare('PRAGMA page_size').get()
  check.close()
  const verdict = String(Object.values(integrity[0] || {})[0] || '')
  if (verdict !== 'ok') throw new Error(`保留区改造后完整性校验失败：${verdict}`)
  return pageSize
}

function createPlainDb(path) {
  rmSync(path, { force: true })
  const { page_size: pageSize } = patchReserve(path)
  if (Number(pageSize) !== 4096) throw new Error(`页大小不是 4096：${pageSize}`)

  const db = new DatabaseSync(path)

  db.exec(`
    create table contact (
      id integer primary key,
      username text not null,
      alias text,
      remark text,
      nick_name text
    );
    create table Name2Id (
      rowid integer primary key,
      user_name text not null
    );
  `)

  const insContact = db.prepare('insert into contact (username, alias, remark, nick_name) values (?, ?, ?, ?)')
  for (const c of contacts) insContact.run(c.username, c.alias, c.remark, c.nick)

  const ids = new Map([
    [SELF, 1],
    [FRIEND, 2],
    [ROOM, 3],
  ])
  const insId = db.prepare('insert into Name2Id (rowid, user_name) values (?, ?)')
  for (const [u, id] of ids) insId.run(id, u)

  const makeTable = (name) => {
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

  const insert = (table, rows) => {
    const stmt = db.prepare(
      `insert into "${table}"
        (local_id, server_id, local_type, sort_seq, real_sender_id, create_time, status, message_content, compress_content, WCDB_CT_message_content)
        values (?, ?, ?, ?, ?, ?, 0, ?, null, ?)`
    )
    let i = 0
    for (const [ts, type, sender, text] of rows) {
      i++
      const compressed = i === rows.length && text.length > 100
      const body = compressed ? zstdCompressSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8')
      stmt.run(i, 100000 + i, type, i, ids.get(sender), ts, body, compressed ? 4 : 0)
    }
  }

  const friendTable = tableNameOf(FRIEND)
  const roomTable = tableNameOf(ROOM)
  makeTable(friendTable)
  makeTable(roomTable)
  insert(friendTable, friendMsgs)
  insert(roomTable, roomMsgs)

  db.close()
  return { friendTable, roomTable }
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const plainPath = join(OUT_DIR, 'demo_plain.db')
  const encPath = join(OUT_DIR, 'message_0.db.enc')

  const { friendTable, roomTable } = createPlainDb(plainPath)
  const plain = readFileSync(plainPath)
  const salt = randomBytes(16)
  const key = randomBytes(32)
  const enc = encryptFile(plain, key, salt)
  writeFileSync(encPath, enc)
  rmSync(plainPath, { force: true })

  writeFileSync(
    join(OUT_DIR, 'meta.json'),
    JSON.stringify(
      {
        note: '全部为合成的演示数据，不含任何真实账号或聊天内容',
        self: SELF,
        selfName: '我',
        friendTable,
        friendName: '阿岚',
        roomTable,
        roomName: '项目组',
        keyHex: key.toString('hex'),
        saltHex: salt.toString('hex'),
        pages: Math.ceil(plain.length / 4096),
        bytes: enc.length,
      },
      null,
      2
    ),
    'utf8'
  )

  console.log(`已生成演示库：${encPath}`)
  console.log(`  页数 ${Math.ceil(plain.length / 4096)}，大小 ${enc.length} 字节`)
  console.log(`  好友表 ${friendTable}`)
}

main()
