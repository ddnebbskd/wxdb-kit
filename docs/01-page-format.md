# 页面格式

WCDB（微信的 SQLite 封装）用 SQLCipher 4 的参数加密整库。
下面是实测得到的布局，`src/sqlcipher.mjs` 按这个实现。

## 参数

| 项 | 值 |
| --- | --- |
| 算法 | AES-256-CBC |
| 页大小 | 4096 字节 |
| 保留区 | 80 字节 = IV 16 + HMAC-SHA512 64 |
| 可用空间 | 4096 − 80 = 4016 字节 |
| KDF | PBKDF2-HMAC-SHA512 |
| MAC 密钥 | `pbkdf2(enc_key, salt XOR 0x3a, 2 轮, 32 字节)` |

## 每页布局

```
第 1 页    [ salt 16 ][ ciphertext 4000 ][ IV 16 ][ HMAC 64 ]
其余页     [     ciphertext 4016       ][ IV 16 ][ HMAC 64 ]
```

页号从 1 开始。第 1 页开头那 16 字节是**文件盐**，
它只出现在第 1 页，之后每页都不带。

## HMAC 原文

```
HMAC-SHA512(mac_key, ciphertext || IV || page_no_LE32)
```

`page_no` 是 4 字节小端。页号参与计算，所以页被调换位置会被发现。

## 解密

```
plain[16..4016] = AES-256-CBC-decrypt(enc_key, IV, page1[16..4016])   // 第 1 页
plain[ 0..4016] = AES-256-CBC-decrypt(enc_key, IV, pageN[ 0..4016])   // 其余页
plain[4016..4096] = 0                                                  // 保留区补零
```

关闭 padding（`setAutoPadding(false)`）：密文长度本来就是 16 的整数倍，
开着 padding 反而会在尾部报错。

第 1 页解密后前 16 字节应当是 `SQLite format 3\0`，这是第二道校验。

## 为什么保留区是 80

SQLite 支持每页末尾留一段不进 b-tree 的空间，值记在文件头第 20 字节
（`reserved space per page`）。SQLCipher 就是借用这 80 字节放 IV 和 HMAC。

这也解释了为什么**不能只改文件头第 20 字节**把一个普通库伪装成加密库：
b-tree 的单元格是从可用空间末尾向前排的，可用空间一变，
原来的单元格就越界了，SQLite 会直接报

```
database disk image is malformed
```

`tools/make-fixture.mjs` 里合成演示库时要同时改两处：

- 偏移 20：每页保留字节数
- 偏移 105：第 1 页 b-tree 头的「单元格内容区起点」

改完跑 `PRAGMA integrity_check` 确认是 `ok`，再往里写数据。

## 密钥校验

只看 HMAC 是不够的，只看解密是否抛错也不够——
AES-CBC 拿错密钥也会照样吐 4096 字节。
所以两道一起过：

1. 算第 1 页 HMAC，和文件里存的 64 字节做**常量时间比较**
2. 解密第 1 页，前 16 字节必须等于 SQLite 魔数

两道都过，才算「密钥正确」。`verifyKey()` 就是这个意思。
