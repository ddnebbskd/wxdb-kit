/**
 * 导出：把一个会话的原始行变成人能读的文本 / JSON。
 *
 * 设计原则：
 *   1. 先按时间排序，再按 local_id 兜底，防止同一秒内的消息错位
 *   2. 发送者一律用备注名，不用 wxid；自己的消息记成「我」
 *   3. 图片、语音、文件只留类型标签，不去碰附件本体
 *   4. 系统消息（撤回、拍一拍、入群提示）不导出
 */
import { writeFileSync } from 'node:fs'
import { decodeField } from './wcdb.mjs'
import { renderMessage, splitGroupPrefix } from './message.mjs'

export function readRawMessages(db, tableName) {
  const rows = db
    .prepare(
      `select local_id, local_type, create_time, sort_seq, real_sender_id,
              message_content, compress_content, WCDB_CT_message_content
         from "${tableName}"
        order by create_time asc, sort_seq asc, local_id asc`
    )
    .all()

  return rows.map((r) => {
    const text =
      decodeField(r.message_content, Number(r.WCDB_CT_message_content || 0)) ||
      decodeField(r.compress_content, 0)
    return {
      id: Number(r.local_id),
      ts: Number(r.create_time),
      type: Number(r.local_type),
      senderId: Number(r.real_sender_id || 0),
      text,
    }
  })
}

export function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

export function formatTime(ts) {
  const d = new Date(ts * 1000)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/** 统一算出一条消息的发送者显示名 */
function resolveSender(msg, nameMap, contacts, selfUsername) {
  let username = nameMap.get(msg.senderId) || ''
  let body = renderMessage(msg.type, msg.text)

  // 群聊正文前缀里带真实发送者
  const split = splitGroupPrefix(msg.text)
  if (split.sender) {
    username = split.sender
    body = renderMessage(msg.type, split.body)
  }

  if (username === selfUsername) return { name: '我', body }
  const info = contacts.get(username)
  const name = info ? info.remark || info.nick || info.alias || username : username || '未知'
  return { name, body }
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {Map<number,string>} opts.nameMap   Name2Id
 * @param {Map<string,object>} opts.contacts
 * @param {string} opts.selfUsername
 * @param {string} opts.selfName
 * @param {string} opts.outPath
 * @param {string} [opts.cutoff]   只导出这个时间之前的（'YYYY-MM-DD HH:mm:ss'）
 * @param {boolean} [opts.textOnly]
 */
export function exportConversation(db, opts) {
  const { tableName, nameMap, contacts, selfUsername, selfName, outPath } = opts
  const cutoff = opts.cutoff ? Math.floor(new Date(opts.cutoff.replace(/-/g, '/')).getTime() / 1000) : null
  const textOnly = !!opts.textOnly

  const raw = readRawMessages(db, tableName)
  const lines = []
  const stat = { total: 0, kept: 0, byBase: {} }
  let lastDay = ''

  for (const m of raw) {
    stat.total++
    const base = m.type % 4294967296
    stat.byBase[base] = (stat.byBase[base] || 0) + 1
    if (textOnly && base !== 1) continue
    if (cutoff && m.ts >= cutoff) continue

    const { name, body } = resolveSender(m, nameMap, contacts, selfUsername)
    if (!body) continue
    if (base === 1 && !body.trim()) continue
    if (body.startsWith('[系统]')) continue

    const day = formatTime(m.ts).slice(0, 10)
    if (day !== lastDay) {
      lines.push('', `===== ${day} =====`)
      lastDay = day
    }
    lines.push(`[${formatTime(m.ts)}] ${name}: ${body}`)
    stat.kept++
  }

  const head = [
    `会话：${opts.title || tableName}`,
    `账号：${selfName || '我'}`,
    `消息表：${tableName}`,
    cutoff ? `范围：全部 ~ ${opts.cutoff}` : '范围：全部',
    `原始条数：${stat.total}　导出条数：${stat.kept}`,
    textOnly ? '模式：仅文本' : '模式：全类型（附件只记类型）',
  ].join('\n')

  writeFileSync(outPath, head + '\n' + lines.join('\n') + '\n', 'utf8')
  return { ...stat, outPath }
}

/** 同样的数据导出成 JSON，方便二次加工 */
export function exportJson(db, opts) {
  const { tableName, nameMap, contacts, selfUsername, outPath } = opts
  const raw = readRawMessages(db, tableName)
  const out = []
  for (const m of raw) {
    const { name, body } = resolveSender(m, nameMap, contacts, selfUsername)
    if (!body || body.startsWith('[系统]')) continue
    out.push({ time: formatTime(m.ts), ts: m.ts, sender: name, type: m.type, text: body })
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
  return out.length
}
