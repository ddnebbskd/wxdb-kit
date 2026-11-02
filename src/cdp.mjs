/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 用途：在已经登录的浏览器里做只读取数（比如把网页上的结构化内容抓下来），
 * 不需要装 puppeteer 那种大依赖。
 *
 * 用法：
 *   const cdp = await connect(9222)          // 连上 localhost:9222 的第一个页面
 *   await cdp.send('Page.navigate', { url }) // 任意 CDP 命令
 *   await cdp.evaluate('document.title')     // 在页面里求值
 *   await cdp.screenshot('a.png')            // 截图
 *   cdp.close()
 *
 * 坑：Page.captureScreenshot 的 clip 参数必须是 double，
 * 传整数会被 CDP 直接拒绝（BINDINGS: double value expected）。
 */
import { writeFileSync } from 'node:fs'

export async function listTargets(port = 9222) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

export async function connect(port = 9222, match = () => true) {
  const targets = await listTargets(port)
  const page = targets.find((t) => t.type === 'page' && match(t))
  if (!page) throw new Error('没有找到可用的页面目标')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  let seq = 0
  const pending = new Map()

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })

  function send(method, params = {}) {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function evaluate(expression, { byValue = true, awaitPromise = true } = {}) {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: byValue,
      awaitPromise,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result?.value
  }

  async function navigate(url, waitMs = 1500) {
    await send('Page.navigate', { url })
    await sleep(waitMs)
  }

  async function screenshot(path, { scale = 1 } = {}) {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  }

  async function screenshotClip(path, { x, y, width, height, scale = 1 }) {
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: +x, y: +y, width: +width, height: +height, scale: +scale },
    })
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  }

  /** 在所有同源 iframe 里执行并取回结果 */
  async function evaluateInFrames(expression) {
    const { frameTree } = await send('Page.getFrameTree')
    const out = []
    const walk = (node) => {
      out.push(node.frame.id)
      for (const child of node.childFrames || []) walk(child)
    }
    walk(frameTree)
    const results = []
    for (const frameId of out) {
      try {
        const ctx = await send('Page.createIsolatedWorld', {
          frameId,
          worldName: 'probe',
          grantUniveralAccess: true,
        })
        const r = await send('Runtime.evaluate', {
          expression,
          contextId: ctx.executionContextId,
          returnByValue: true,
        })
        results.push({ frameId, value: r.result?.value })
      } catch (e) {
        results.push({ frameId, error: String(e.message) })
      }
    }
    return results
  }

  return { send, evaluate, navigate, screenshot, screenshotClip, evaluateInFrames, close: () => ws.close(), sleep }
}
