/**
 * 端到端演示：解密 → 打开 → 解析 → 导出。
 *
 * 跑法：
 *   node tools/make-fixture.mjs   # 生成演示库（只需一次）
 *   node tools/demo.mjs
 *
 * 输出：
 *   out/demo.db            解密后的明文库
 *   out/阿岚.txt          单聊导出
 *   out/项目组.txt        群聊导出
 *   out/阿岚.json         同数据的结构化版本
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyKey, saltOf, decryptFile } from '../src/sqlcipher.mjs'
import { openDb, name2id } from '../src/wcdb.mjs'
import { readContacts } from '../src/contact.mjs'
import { exportConversation, exportJson } from '../src/export.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IN = join(ROOT, 'fixture')
const OUT = join(ROOT, 'out')

function main() {
  mkdirSync(OUT, { recursive: true })

  const meta = JSON.parse(readFileSync(join(IN, 'meta.json'), 'utf8'))
  const encPath = join(IN, 'message_0.db.enc')
  const key = Buffer.from(meta.keyHex, 'hex')

  // 1. 校验密钥：HMAC + 页头双检
  const buf = readFileSync(encPath)
  const page1 = buf.subarray(0, 4096)
  const ok = verifyKey(key, page1)
  const salt = saltOf(page1)
  console.log(`密钥校验：${ok ? '通过' : '失败'}`)
  console.log(`文件盐：${salt.toString('hex').slice(0, 16)}…`)

  if (!ok) {
    console.log('试着用错误的密钥再验一次，应该失败：', verifyKey(Buffer.alloc(32, 7), page1))
    process.exitCode = 1
    return
  }

  // 2. 解密
  const dbPath = join(OUT, 'demo.db')
  const pages = decryptFile(encPath, dbPath, key)
  console.log(`解密完成：${pages} 页 → out/demo.db`)

  // 3. 打开并读元信息
  const db = openDb(dbPath)
  const ids = name2id(db)
  const contacts = readContacts(db)
  console.log(`Name2Id ${ids.size} 条，联系人 ${contacts.size} 条`)

  // 4. 导出
  const self = meta.selfName || '我'
  const common = { nameMap: ids, contacts, selfUsername: meta.self, selfName: self }
  const a = exportConversation(db, {
    ...common,
    tableName: meta.friendTable,
    title: meta.friendName,
    outPath: join(OUT, `${meta.friendName}.txt`),
  })
  const b = exportConversation(db, {
    ...common,
    tableName: meta.roomTable,
    title: meta.roomName,
    outPath: join(OUT, `${meta.roomName}.txt`),
  })
  const c = exportJson(db, {
    ...common,
    tableName: meta.friendTable,
    outPath: join(OUT, `${meta.friendName}.json`),
  })

  db.close()

  console.log(`\n${meta.friendName}：${a.total} 条原始，导出 ${a.kept} 条`)
  console.log(`  类型分布：${JSON.stringify(a.byBase)}`)
  console.log(`${meta.roomName}：${b.total} 条原始，导出 ${b.kept} 条`)
  console.log(`JSON：${c} 条`)

  // 5. 自检：应有文本、图片、语音、引用、转账、系统消息各就位
  const text = readFileSync(a.outPath, 'utf8')
  const checks = [
    ['文本', /早，今天那个库跑通了吗/],
    ['zstd 压缩字段', /演示用长文本/],
    ['引用', /\[引用\]/],
    ['转账', /\[转账\]/],
    ['链接', /\[链接\]/],
    ['语音', /\[语音\]/],
    ['图片', /\[图片\]/],
    ['系统消息已过滤', null],
  ]
  console.log('\n自检：')
  for (const [name, re] of checks) {
    if (re === null) {
      const leaked = /\[系统\]/.test(text)
      console.log(`  ${name}：${leaked ? '未过滤（有问题）' : '正常'}`)
      if (leaked) process.exitCode = 1
      continue
    }
    const hit = re.test(text)
    console.log(`  ${name}：${hit ? '命中' : '缺失（有问题）'}`)
    if (!hit) process.exitCode = 1
  }
}

main()
