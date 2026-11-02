/**
 * 随机化压力测试。
 *
 * 目的：证明这套解析在"没见过的数据"上也成立，而不只是在这份写死的
 * 演示库上成立。每个用例都会随机生成联系人、消息类型、长文本、群前缀、
 * 空正文、未知发送者、未知类型，然后走完整链路：
 *
 *   建库 → 加密 → 校验密钥 → 解密 → 打开 → 解析 → 导出 → 逐条核对
 *
 * 跑法：
 *   node tools/stress.mjs --cases 8 --seed 1
 *   node tools/stress.mjs --cases 20 --seed 42 --keep
 *
 * 退出码：有任何一条断言失败就是 1。
 */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encryptFile, verifyKey, decryptFile, saltOf, IV_OFFSET } from '../src/sqlcipher.mjs'
import { openDb, name2id } from '../src/wcdb.mjs'
import { readContacts, tableNameOf } from '../src/contact.mjs'
import { exportConversation, exportJson, readRawMessages, formatTime } from '../src/export.mjs'
import { APP_SUBTYPE, POW32 } from '../src/message.mjs'
import { PAGE_SIZE, patchReserve, makeMessageTable, insertMessages } from './sqlite-fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WORK = join(ROOT, 'fixture-stress')

// ---------------- 参数 ----------------
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const CASES = Number(argOf('cases', 8))
const SEED = Number(argOf('seed', 1))
const KEEP = argv.includes('--keep')

// ---------------- 伪随机 ----------------
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const makeRnd = (seed) => {
  const r = mulberry32(seed)
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
  const pick = (arr) => arr[Math.floor(r() * arr.length)]
  const chance = (p) => r() < p
  return { r, int, pick, chance }
}

// ---------------- 造数据用的素材 ----------------
const NAME_POOL = ['阿岚', '小周🌿', 'Zoe', '老王', '🦊', 'Anonymous User', '名字很长很长很长很长的联系人', '测试群A', '项目组', '亲友团']
const TEXT_POOL = [
  '早',
  '在吗？',
  '这个报错怎么解决',
  '好',
  '多行\n第二行',
  'emoji 😀🎉 混排',
  '   ',
  '引号"双"和\'单\'',
  '<b>这不是标签，是内容</b>',
  '0x3a 记成 0x3b 了',
  'https://example.com/x?a=1&b=2',
  '  前后都有空格  ',
]
const LONG_TEXT = '这是一段足够长的正文，用来触发 zstd 压缩路径，需要超过一百五十字节。'.repeat(6)

const APP_SUBS = [1, 3, 4, 5, 6, 8, 19, 33, 36, 51, 57, 63, 2000, 2001, 2003, 2004, 999]

function cardXml(sub, rnd) {
  const title = rnd.pick(['一张卡片', '今天的链接', '红包来了', ''])
  const des = rnd.pick(['说明文字', '', '第二行\n第三行'])
  return `<msg><appmsg appid="" sdkver="0"><title>${title}</title><des>${des}</des><type>${sub}</type></appmsg></msg>`
}

function systemXml(rnd) {
  return `<sysmsg type="revokemsg"><content>${rnd.pick(['你撤回了一条消息', '某某 加入了群聊', ''])}</content></sysmsg>`
}

// ---------------- 生成一个用例 ----------------
function buildCase(caseIndex, baseSeed) {
  const rnd = makeRnd(baseSeed + caseIndex * 7919)

  const self = 'wxid_demo_me'
  const friendCount = rnd.int(1, 3)
  const roomCount = rnd.int(1, 2)
  const unknownId = 99 // 故意不在 Name2Id 里

  const people = []
  let nextId = 2
  for (let i = 0; i < friendCount; i++) {
    people.push({ username: `wxid_demo_f${i}`, name: rnd.pick(NAME_POOL), id: nextId++, isRoom: false })
  }
  for (let i = 0; i < roomCount; i++) {
    people.push({ username: `${10000000000 + i}@chatroom`, name: rnd.pick(NAME_POOL), id: nextId++, isRoom: true })
  }

  const tables = people.map((p) => {
    const count = rnd.pick([0, 1, 3, 17, 120, 400])
    const rows = []
    let ts = Math.floor(new Date('2024-01-05T08:00:00+08:00').getTime() / 1000)
    for (let i = 0; i < count; i++) {
      ts += rnd.int(1, 900)
      const roll = rnd.r()
      let type
      let text = ''
      let zstd

      if (roll < 0.55) {
        // 文本
        type = 1
        text = rnd.chance(0.12) ? LONG_TEXT : rnd.pick(TEXT_POOL)
        if (rnd.chance(0.08)) zstd = true // 短文本也标压缩，测 WCDB_CT 分支
      } else if (roll < 0.63) {
        type = 3
        text = rnd.chance(0.3) ? null : '' // 附件可能连空 BLOB 都没有
      } else if (roll < 0.68) {
        type = 34
      } else if (roll < 0.72) {
        type = 43
      } else if (roll < 0.77) {
        type = 47
      } else if (roll < 0.8) {
        type = rnd.pick([42, 48, 50])
      } else if (roll < 0.92) {
        const sub = rnd.chance(0.05) ? 0 : rnd.pick(APP_SUBS)
        type = sub ? 49 + sub * POW32 : 49
        text = sub ? cardXml(sub, rnd) : ''
      } else if (roll < 0.97) {
        type = 10000
        text = systemXml(rnd)
      } else {
        type = rnd.pick([9999, 12345, 7]) // 未知 base
      }

      const senderId = rnd.chance(0.06) ? unknownId : rnd.pick([1, ...people.map((p) => p.id)])
      if (p.isRoom && rnd.chance(0.75) && type === 1) {
        text = `wxid_demo_f${rnd.int(0, friendCount - 1)}:\n${text}`
      }

      rows.push({ ts, type, senderId, text, zstd })
    }
    return { ...p, rows, tableName: tableNameOf(p.username) }
  })

  return { self, people, tables, unknownId }
}

// ---------------- 独立算一遍"应该导出多少条" ----------------
// 这不是调用 src 的实现，而是照规格重写一遍，用来对账。
function stripPrefix(text) {
  const m = /^(wxid_[A-Za-z0-9_@-]+|[a-zA-Z0-9_-]{6,}@chatroom):\n/.exec(text || '')
  return m ? text.slice(m[0].length) : text || ''
}

function expectRow(row, isRoom) {
  const type = Number(row.type) || 0
  const base = type % POW32
  const sub = Math.floor(type / POW32)
  let text = row.text == null ? '' : String(row.text)
  if (isRoom) text = stripPrefix(text)

  if (base === 10000) return { keep: false, base, body: '' }
  if (base === 49 && sub) return { keep: true, base, body: `[${APP_SUBTYPE[sub] || '卡片'}]` }
  if (base === 1) {
    const body = text.trim()
    return { keep: body.length > 0, base, body }
  }
  return { keep: true, base, body: `[${base}]` }
}

function expectStats(rows, isRoom, opts = {}) {
  let kept = 0
  const texts = []
  for (const row of rows) {
    const e = expectRow(row, isRoom)
    if (!e.keep) continue
    if (opts.textOnly && e.base !== 1) continue
    if (opts.cutoff && row.ts >= opts.cutoff) continue
    kept++
    if (e.base === 1) texts.push(e.body)
  }
  return { kept, texts }
}

// ---------------- 跑一个用例 ----------------
function runCase(caseIndex, baseSeed) {
  const spec = buildCase(caseIndex, baseSeed)
  const dir = join(WORK, `case-${caseIndex}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const fails = []
  const check = (ok, label, detail) => {
    if (!ok) fails.push(detail ? `${label}（${detail}）` : label)
  }

  // 1. 建明文库
  const plainPath = join(dir, 'plain.db')
  const pageSize = patchReserve(plainPath)
  check(Number(pageSize) === PAGE_SIZE, '保留区改造后页大小应为 4096', String(pageSize))

  const db = new DatabaseSync(plainPath)
  db.exec(`
    create table contact (id integer primary key, username text not null, alias text, remark text, nick_name text);
    create table Name2Id (rowid integer primary key, user_name text not null);
  `)
  const insContact = db.prepare('insert into contact (username, alias, remark, nick_name) values (?, ?, ?, ?)')
  insContact.run(spec.self, 'demo_me', '', '演示号')
  for (const p of spec.people) insContact.run(p.username, '', p.name, p.name)

  const insId = db.prepare('insert into Name2Id (rowid, user_name) values (?, ?)')
  insId.run(1, spec.self)
  for (const p of spec.people) insId.run(p.id, p.username)

  for (const t of spec.tables) {
    makeMessageTable(db, t.tableName)
    insertMessages(db, t.tableName, t.rows)
  }
  db.close()

  // 2. 加密
  const plain = readFileSync(plainPath)
  const key = randomBytes(32)
  const salt = randomBytes(16)
  const encPath = join(dir, 'message_0.db.enc')
  const enc = encryptFile(plain, key, salt)
  writeFileSync(encPath, enc)

  // 3. 校验密钥
  const page1 = enc.subarray(0, PAGE_SIZE)
  check(verifyKey(key, page1) === true, '正确密钥应校验通过')
  check(verifyKey(Buffer.alloc(32, 9), page1) === false, '错误密钥应校验失败')
  check(saltOf(page1).equals(salt), '从第 1 页读出的盐应与写入的一致')

  // 4. 解密
  const outPath = join(dir, 'decrypted.db')
  const pages = decryptFile(encPath, outPath, key)
  check(pages === Math.ceil(enc.length / PAGE_SIZE), '解密页数应等于 密文长度/4096',
    `${pages} vs ${Math.ceil(enc.length / PAGE_SIZE)}`)
  const decrypted = readFileSync(outPath)
  check(decrypted.length === plain.length, '解密结果应和原文等长',
    `${decrypted.length} vs ${plain.length}`)

  // 只比对每页的可用区（4016 字节）；尾部 80 字节保留区本来就该被清零
  let usableSame = true
  let tailZero = true
  for (let p = 0; p * PAGE_SIZE < plain.length; p++) {
    const at = p * PAGE_SIZE
    const a = plain.subarray(at, at + IV_OFFSET)
    const b = decrypted.subarray(at, at + IV_OFFSET)
    if (!a.equals(b)) usableSame = false
    const tail = decrypted.subarray(at + IV_OFFSET, at + PAGE_SIZE)
    if (tail.some((x) => x !== 0)) tailZero = false
  }
  check(usableSame, '每页可用区解密后应和原文逐字节相同')
  check(tailZero, '解密输出的保留区应是全 0')

  // 5. 打开、解析、导出
  const rdb = openDb(outPath)
  const ids = name2id(rdb)
  const contacts = readContacts(rdb)
  check(ids.size === spec.people.length + 1, 'Name2Id 条数应等于（自己 + 联系人）', String(ids.size))
  check(contacts.size === spec.people.length + 1, '联系人条数应等于（自己 + 联系人）', String(contacts.size))

  const common = { nameMap: ids, contacts, selfUsername: spec.self, selfName: '我' }
  let totalRaw = 0
  let totalKept = 0

  for (const t of spec.tables) {
    const raw = readRawMessages(rdb, t.tableName)
    check(raw.length === t.rows.length, `[${t.name}] 读出的原始行数应等于写入行数`,
      `${raw.length} vs ${t.rows.length}`)
    totalRaw += raw.length

    const cut = median(t.rows.map((r) => r.ts))
    const wanted = expectStats(t.rows, t.isRoom)
    const wantedText = expectStats(t.rows, t.isRoom, { textOnly: true })
    const wantedCut = expectStats(t.rows, t.isRoom, { cutoff: cut })

    const txtPath = join(dir, `${t.name}.txt`)
    const stat = exportConversation(rdb, { ...common, tableName: t.tableName, title: t.name, outPath: txtPath })
    check(stat.total === t.rows.length, `[${t.name}] 统计的总条数应等于写入行数`, `${stat.total} vs ${t.rows.length}`)
    check(stat.kept === wanted.kept, `[${t.name}] 导出条数应与独立计算一致`, `${stat.kept} vs ${wanted.kept}`)
    totalKept += stat.kept

    const txt = readFileSync(txtPath, 'utf8')
    check(!txt.includes('[系统]'), `[${t.name}] 导出里不应出现系统消息`)
    if (stat.kept > 0) check(txt.includes(`会话：${t.name}`), `[${t.name}] 头部应有会话名`)

    // 时间必须单调不减
    const stamps = [...txt.matchAll(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/gm)].map((m) => m[1])
    check(stamps.length === stat.kept, `[${t.name}] 带时间戳的行数应等于导出条数`, `${stamps.length} vs ${stat.kept}`)
    const sorted = stamps.every((s, i) => i === 0 || s >= stamps[i - 1])
    check(sorted, `[${t.name}] 时间戳应单调不减`)

    // 文本消息原文必须一字不差地出现
    const sample = wanted.texts.filter((s) => s.length > 0 && s.length < 400).slice(0, 6)
    for (const s of sample) {
      check(txt.includes(s), `[${t.name}] 原文应原样出现: ${JSON.stringify(s.slice(0, 24))}`)
    }

    // 仅文本模式
    const textStat = exportConversation(rdb, {
      ...common, tableName: t.tableName, title: t.name,
      outPath: join(dir, `${t.name}.text.txt`), textOnly: true,
    })
    check(textStat.kept === wantedText.kept, `[${t.name}] 仅文本模式条数应对`,
      `${textStat.kept} vs ${wantedText.kept}`)

    // 时间截断
    const cutStat = exportConversation(rdb, {
      ...common, tableName: t.tableName, title: t.name,
      outPath: join(dir, `${t.name}.cut.txt`), cutoff: formatTime(cut),
    })
    check(cutStat.kept === wantedCut.kept, `[${t.name}] 截止时间过滤条数应对`,
      `${cutStat.kept} vs ${wantedCut.kept}`)

    // JSON
    const jsonPath = join(dir, `${t.name}.json`)
    const jsonCount = exportJson(rdb, { ...common, tableName: t.tableName, outPath: jsonPath })
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
    check(jsonCount === stat.kept, `[${t.name}] JSON 条数应等于文本导出条数`, `${jsonCount} vs ${stat.kept}`)
    check(parsed.length === jsonCount, `[${t.name}] JSON 数组长度应与返回值一致`)
    check(parsed.every((m) => typeof m.sender === 'string' && m.sender.length > 0), `[${t.name}] 每条都应有发送者`)

    // 未知发送者不能崩，也不能导出成空名字
    check(!/\] : /.test(txt), `[${t.name}] 不应出现空发送者`)
    const unknownKept = t.rows
      .filter((r) => r.senderId === spec.unknownId)
      .some((r) => expectRow(r, t.isRoom).keep)
    if (unknownKept && !t.isRoom) {
      check(txt.includes('未知'), `[${t.name}] 未登记的发送者应显示为「未知」`)
    }
  }

  rdb.close()

  if (!KEEP) rmSync(dir, { recursive: true, force: true })

  return { caseIndex, tables: spec.tables.length, raw: totalRaw, kept: totalKept, fails }
}

function median(nums) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// ---------------- 主流程 ----------------
function main() {
  mkdirSync(WORK, { recursive: true })
  const started = Date.now()
  const results = []

  for (let i = 1; i <= CASES; i++) {
    const r = runCase(i, SEED)
    results.push(r)
    const tag = r.fails.length === 0 ? 'PASS' : 'FAIL'
    console.log(`用例 ${String(i).padStart(2, '0')} [${tag}]  表 ${r.tables}  原始 ${r.raw}  导出 ${r.kept}`)
    for (const f of r.fails) console.log(`          - ${f}`)
  }

  const bad = results.filter((r) => r.fails.length > 0)
  const rawSum = results.reduce((a, r) => a + r.raw, 0)
  const keptSum = results.reduce((a, r) => a + r.kept, 0)
  const ms = Date.now() - started

  console.log('')
  console.log(`共 ${CASES} 个用例　通过 ${CASES - bad.length}　失败 ${bad.length}`)
  console.log(`消息 ${rawSum} 条，导出 ${keptSum} 条，用时 ${ms} ms　种子 ${SEED}`)

  if (bad.length) {
    console.log('\n失败明细：')
    for (const r of bad) for (const f of r.fails) console.log(`  用例 ${r.caseIndex}: ${f}`)
    process.exitCode = 1
  }
}

main()
