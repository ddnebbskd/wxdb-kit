/**
 * 微信 4.x 本地库页面解密
 *
 * 格式（与 WCDB(SQLCipher 4) 实测一致）：
 *   AES-256-CBC，页大小 4096，保留区 80 字节（IV 16 + HMAC-SHA512 64）
 *
 *   第 1 页：[salt 16][ciphertext 4000][IV 16][HMAC 64]
 *   其余页：[ciphertext 4016][IV 16][HMAC 64]
 *
 *   mac_key = PBKDF2-SHA512(enc_key, salt XOR 0x3a, 2 轮, 32 字节)
 *   HMAC    = SHA512-HMAC(mac_key, ciphertext || IV || page_no(LE32))
 *
 * 只读：本模块只产出新的明文副本，不触碰原始文件。
 * 仅用于解析本人账号、本人设备上的数据。
 */
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

export const PAGE = 4096
export const RESERVE = 80
export const SALT_SIZE = 16
export const IV_SIZE = 16
export const HMAC_SIZE = 64
export const IV_OFFSET = PAGE - RESERVE // 4016
export const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1')

const ZEROS = Buffer.alloc(RESERVE)
const PAGE_NO = Buffer.alloc(4)

/** SQLCipher 的 MAC 盐：文件盐逐字节异或 0x3a */
function macKeyOf(encKey, salt) {
  const macSalt = Buffer.alloc(salt.length)
  for (let i = 0; i < salt.length; i++) macSalt[i] = salt[i] ^ 0x3a
  return pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512')
}

/** 一页的 HMAC 原文：密文 + IV + 页号（小端 4 字节） */
function hmacOf(macKey, cipherText, iv, pageNo) {
  const h = createHmac('sha512', macKey)
  h.update(cipherText)
  h.update(iv)
  PAGE_NO.writeUInt32LE(pageNo, 0)
  h.update(PAGE_NO)
  return h.digest()
}

/** 从第 1 页取出文件盐 */
export function saltOf(page1) {
  return page1.subarray(0, SALT_SIZE)
}

/**
 * 校验密钥：HMAC 对得上，且解密出来的页头是 SQLite 魔数。
 * 只有两项都过，才算密钥正确。
 */
export function verifyKey(encKey, page1) {
  if (page1.length < PAGE) return false
  const salt = saltOf(page1)
  const expect = page1.subarray(PAGE - HMAC_SIZE)
  let got
  try {
    got = hmacOf(macKeyOf(encKey, salt), page1.subarray(SALT_SIZE, IV_OFFSET), page1.subarray(IV_OFFSET, IV_OFFSET + IV_SIZE), 1)
  } catch {
    return false
  }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return false
  try {
    return decryptPage(encKey, page1, 1).subarray(0, SALT_SIZE).equals(SQLITE_HEADER)
  } catch {
    return false
  }
}

/** 解一页，返回 4096 字节明文页（尾部 80 字节保留区补 0） */
export function decryptPage(encKey, page, pageNo) {
  const iv = page.subarray(IV_OFFSET, IV_OFFSET + IV_SIZE)
  const body = pageNo === 1 ? page.subarray(SALT_SIZE, IV_OFFSET) : page.subarray(0, IV_OFFSET)
  const decipher = createDecipheriv('aes-256-cbc', encKey, iv)
  decipher.setAutoPadding(false)
  const out = Buffer.concat([decipher.update(body), decipher.final()])
  return pageNo === 1 ? Buffer.concat([SQLITE_HEADER, out, ZEROS]) : Buffer.concat([out, ZEROS])
}

/** 加密一页（仅用于生成演示数据，与 decryptPage 严格对称） */
export function encryptPage(encKey, plain, pageNo, iv) {
  const vector = iv || randomBytes(IV_SIZE)
  const body = pageNo === 1 ? plain.subarray(SALT_SIZE, IV_OFFSET) : plain.subarray(0, IV_OFFSET)
  const cipher = createCipheriv('aes-256-cbc', encKey, vector)
  cipher.setAutoPadding(false)
  const cipherText = Buffer.concat([cipher.update(body), cipher.final()])
  return { cipherText, iv: vector }
}

/** 整库解密，返回页数 */
export function decryptFile(src, dst, encKey) {
  const buf = readFileSync(src)
  const pages = Math.ceil(buf.length / PAGE)
  const out = Buffer.alloc(pages * PAGE)
  for (let i = 0; i < pages; i++) {
    const raw = buf.subarray(i * PAGE, Math.min((i + 1) * PAGE, buf.length))
    const full = raw.length === PAGE ? raw : Buffer.concat([raw, Buffer.alloc(PAGE - raw.length)])
    decryptPage(encKey, full, i + 1).copy(out, i * PAGE)
  }
  writeFileSync(dst, out)
  return pages
}

/**
 * 整库加密（生成演示数据用）。
 * salt 写在第 1 页头部，每页 IV 随机，HMAC 按规范计算。
 */
export function encryptFile(plainBuf, encKey, salt) {
  const pages = Math.ceil(plainBuf.length / PAGE)
  const out = []
  for (let i = 0; i < pages; i++) {
    const no = i + 1
    const raw = plainBuf.subarray(i * PAGE, Math.min((i + 1) * PAGE, plainBuf.length))
    const plain = raw.length === PAGE ? raw : Buffer.concat([raw, Buffer.alloc(PAGE - raw.length)])
    const { cipherText, iv } = encryptPage(encKey, plain, no)
    const hmac = hmacOf(macKeyOf(encKey, salt), cipherText, iv, no)
    out.push(no === 1 ? Buffer.concat([salt, cipherText, iv, hmac]) : Buffer.concat([cipherText, iv, hmac]))
  }
  return Buffer.concat(out)
}
