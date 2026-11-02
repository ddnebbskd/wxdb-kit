/**
 * 消息类型解析。
 *
 * 关键坑：local_type 不是一个小整数，而是
 *   local_type = base + sub_type * 2^32
 * 老版本的脚本用一个 switch(local_type) 去分发，遇到 49 类卡片时
 * 所有子类型都会掉进 default，链接、引用、转账就全成了「未知类型」。
 * 正确做法是先取余拿到 base，再取整除拿到 sub。
 */

export const POW32 = 4294967296

/** 49 类（应用消息）的子类型，取值来自 appmsg 里的 <type> */
export const APP_SUBTYPE = {
  1: '链接',
  3: '音乐',
  4: '视频',
  5: '音乐',
  6: '文件',
  8: '表情包',
  19: '聊天记录',
  33: '小程序',
  36: '小程序',
  51: '不支持的内容',
  57: '引用',
  63: '直播',
  2000: '转账',
  2001: '红包',
  2003: '视频号',
  2004: '视频号',
}

const BASE_LABEL = {
  1: '文本',
  3: '图片',
  34: '语音',
  43: '视频',
  42: '名片',
  47: '表情',
  48: '位置',
  50: '通话',
  49: '卡片',
  10000: '系统',
}

/** 拆出 base / sub */
export function splitType(localType) {
  const n = Number(localType) || 0
  return { base: n % POW32, sub: Math.floor(n / POW32) }
}

/** 从 appmsg XML 里取字段（容忍残缺标签与 CDATA） */
function field(xml, name) {
  const m = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))
  return m ? m[1].trim() : ''
}

/**
 * 把一条消息渲染成一行可读文本。
 * 返回空串表示这条不值得导出（比如系统消息）。
 */
export function renderMessage(localType, content) {
  const { base, sub } = splitType(localType)
  const text = content || ''

  if (base === 49 && sub) {
    const title = field(text, 'title')
    const des = field(text, 'des')
    const label = APP_SUBTYPE[sub] || '卡片'
    if (sub === 2000 || sub === 2001) return `[${label}] ${des || title}`.slice(0, 200)
    if (sub === 19) return `[聊天记录] ${des.replace(/\n/g, ' | ').slice(0, 120)}`
    if (sub === 57) return `[引用] ${title}`.slice(0, 200)
    const body = title || des
    return body ? `[${label}] ${body}`.slice(0, 200) : `[${label}]`
  }

  switch (base) {
    case 1:
      return text.trim()
    case 3:
      return '[图片]'
    case 34:
      return '[语音]'
    case 43:
      return '[视频]'
    case 42:
      return '[名片]'
    case 47:
      return '[表情]'
    case 48:
      return '[位置]'
    case 50:
      return '[通话]'
    case 10000: {
      const body = field(text, 'content') || text.replace(/<[^>]+>/g, '')
      return `[系统] ${body.trim()}`.slice(0, 200)
    }
    default:
      return `[${BASE_LABEL[base] || '类型' + base}]`
  }
}

/** 群消息正文以 "wxid_xxx:\n" 开头，剥掉并返回真实发送者 */
export function splitGroupPrefix(text) {
  const m = /^(wxid_[A-Za-z0-9_@-]+|[a-zA-Z0-9_-]{6,}@chatroom):\n/.exec(text)
  if (!m) return { sender: null, body: text }
  return { sender: m[1], body: text.slice(m[0].length) }
}
