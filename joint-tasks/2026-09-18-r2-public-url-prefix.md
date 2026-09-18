# R2 公开 URL 丢了键前缀

**状态**：`in_progress` ｜ **性质**：api 单端 ｜ 开于 2026-09-18

契约不变，不进 `planning`：SPEC §5.2.6 的 `url` / `thumbUrl` 和 §6.2.3 的 `tempUrl` 字段形状和含义都没动，本次修的是它们**算错了**。

## 1. 为什么要做

2026-09-18 首次接真实 R2（此前 `.env` 里 `R2_*` 全是 `local-dev-placeholder` 这类占位符，从没连通过）。配好凭证和 CORS 后导入成功、对象进了 bucket、行也入了库，但前端**整页裂图**。

对着的是同一张图的两个地址：

```
对象实际位置   mememio/thumbs/4d92a40e-….webp
响应里的 thumbUrl   https://pub-….r2.dev/thumbs/4d92a40e-….webp
                                        ↑ 少了 mememio/
```

`R2_KEY_PREFIX=mememio/`。写入侧每个键都过 `key()` 加前缀（`api/src/storage/r2.ts:41-43`），派生公开 URL 的地方没加。

**这个 bug 在前缀为空时完全不可见**，而 `.env.example` 里 `R2_KEY_PREFIX=mememio/` 是默认给值的，也就是说照文档部署的人一定会中。之所以拖到今天才暴露，是因为在此之前没有任何一次请求真的打到过 R2。

还有一层，比少一段路径更值得记：**派生公开 URL 有两份实现。**

| 位置 | 干什么 | 有没有前缀 |
|---|---|---|
| `api/src/storage/r2.ts:149-151` `publicUrlFor` | 待确认队列的 `tempUrl`（`routes/imports.ts:210`） | ❌ |
| `api/src/serialize/meme.ts:31-37` `storageKeyToUrls` | `url` / `thumbUrl`，**没调 `publicUrlFor`，自己拼了一遍** | ❌ |

`serialize/meme.ts:27-29` 的注释正好记着上一次同类事故——`thumbUrl` 曾经自己推过一套 `/thumb/<storageKey>`，与写入侧对不上，「且对不上时不报错，只是图片 404」。修掉那次之后**路径推导统一了，URL 拼接没统一**，于是同一个坑换了个地方又踩一遍。所以这次不是改两行的事，是把第二份实现删掉。

## 2. 做完的标准

- `R2_KEY_PREFIX` 非空时，响应里的 `url`、`thumbUrl`、`tempUrl` 三个地址**能在浏览器里真的打开**（不是「看起来对」）。
- 派生公开 URL 的实现**只剩一处**。`serialize/meme.ts` 不再自己拼 base 和 key。
- 有一条测试钉住「前缀非空 → URL 含前缀」。**这条是本次的回归锚点**：前缀为空时 bug 不可见，用空前缀写的测试等于没写。
- 库里数据不动。`storageKey` 存的是不带前缀的相对键，和写入侧约定一致，没有迁移。

## 3. api 端

### 3.1 主修（必做）

`publicUrlFor` 走 `key()`：

```ts
export function publicUrlFor(objectKey: string): string {
  return `${env.r2PublicBaseUrl}/${key(objectKey)}`
}
```

`serialize/meme.ts` 的 `storageKeyToUrls` 改成调它，`thumbUrl` 继续经 `thumbKeyFor` 派生键、再交给 `publicUrlFor` 加前缀。`imports.ts:210` 的 `tempUrl` 不用动，跟着就对了。

**不要走另一条路**：把前缀塞进 `R2_PUBLIC_BASE_URL`（填 `https://pub-….r2.dev/mememio`）今天就能跑通，但前缀从此在两个环境变量里各写一份，两边什么时候不一致都不报错。这次的教训恰恰是「同一件事两处实现」，别用它来修它自己。

顺手确认 `key()` 的注释还准确——它现在是唯一的前缀入口了，读和写都靠它。

### 3.2 启动自检（第二件，可独立提交）

今天真正昂贵的不是这个 bug，是**配错了全程没有任何一处报错**：

- `env.ts` 只校验 `R2_*` 填没填，不校验能不能用；
- 预签名是纯本地 HMAC，凭证是假的照样签出格式完美的 URL，`POST /imports` 返回 200；
- 错误最终只以浏览器的 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` 现身，离根因隔了整条链路。

`env.ts:83` 那句「宁可现在起不来」写的就是这个道理，只是没延伸到 R2。建议启动时对 bucket 做一次轻量探活（`HeadBucket`，或 list 一个对象），失败就拒绝启动。

三个约束：

1. **错误信息带 endpoint 和 bucket，绝不带 key**——哪怕片段也不行（硬边界，SPEC §5.3）。
2. **`NODE_ENV=test` 必须跳过**，否则单测全变成要连网，`tests/helpers/r2-memory.ts` 那套内存桩就白搭了。
3. 别把它写成阻塞很久的同步探测，网络不通时要有超时，不能让进程吊死在启动上。

这件事如果做起来比预想的重，**拆成单独一次提交或者退回任务板都可以**，3.1 不等它。

### 3.3 文档（第三件）

放在本任务而不是单开，因为它和 `env.ts` 同源，改的人手上正好有现场：

- **`.env.example` 缺 `R2_PUBLIC_BASE_URL`**，而 `env.ts:109` 是 `required`。照 example 填的人进程直接起不来，且报错要读代码才懂。补上，并写明不能带末尾 `/`（`env.ts:110-112` 会拦）。
- **`docs/deployment.md` 全文没有一处提到 R2 CORS**。落地检查清单（§8）加勾选项，正文补 R2 那一段：开通 → 建 bucket → R2 Overview 的 `{} API` → Manage API Tokens → Create User API Token（Object Read & Write，限定到本 bucket）→ 开 Public Access 拿 `R2_PUBLIC_BASE_URL` → 配 CORS。

今天实测有效的 CORS 策略，原样记进手册（正式域名替换 origin）：

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

值得一并写进手册的两个坑，都是今天现踩的：
- 令牌不在 bucket 设置里，在 **R2 账户级**的 Manage API Tokens；通用 API Tokens 页建出来的令牌只给一个 token value，**不是** S3 的 Access Key ID / Secret Access Key。
- `R2_ACCOUNT_ID` 只填 32 位十六进制那一段，**不要粘整条 endpoint URL**——粘了也不报错，一路错到浏览器 TLS 握手失败。

## 4. 本次不做

| 事 | 为什么不做 |
|---|---|
| `@aws-sdk/client-s3` 3.1132.0 默认 `requestChecksumCalculation: WHEN_SUPPORTED`，预签名 URL 里带着 `x-amz-checksum-crc32=AAAAAA==`（**空 body 的 CRC32**，因为签名时没有 body），而浏览器 PUT 的是真实字节 | 2026-09-18 实测 R2 **放行了**，上传成功。没有复现出失败，就不做预防性改动。**记在这里是为了下次**：若出现 400 `XAmzContentChecksumMismatch` / `BadDigest`，改 `S3Client` 的 `requestChecksumCalculation: 'WHEN_REQUIRED'`，别再从头查一遍 |
| web 的 `uploadToR2` 兜底把 fetch 层失败（CORS、TLS、DNS）和 HTTP 失败压成同一句「上传失败」（`use-import-queue.ts:312`），排查时看不出原因 | web 单端，另开。今天整条排查链走得这么长，这是放大器之一 |

## 5. api 端验收

> 由 api 执行者回填。请写清楚：`R2_KEY_PREFIX` 非空时三个地址各自实测打开了没有（哪个页面、看到图还是 404）、跑了哪些测试、3.2 做了还是退回、文档改了哪几处。没实测的直接写没实测。

2026-09-18 回填。三件事全做了，没有退回。

### 5.1 主修（3.1）

`publicUrlFor` 改成走 `key()`；`serialize/meme.ts` 的第二份实现删掉，`storageKeyToUrls` 现在只是 `publicUrlFor(storageKey)` 和 `publicUrlFor(thumbKeyFor(storageKey))`，`env` 的 import 也跟着去掉了——**那一层现在不知道 base URL 长什么样**，想再自己拼一份得先把 env 导回来。`imports.ts:210` 的 `tempUrl` 没动，跟着就对了。

没走「把前缀塞进 `R2_PUBLIC_BASE_URL`」那条路。

`key()` 的注释补了一句它现在是唯一的前缀入口（读、写、公开 URL 都靠它），因为原注释只讲了「共用 bucket 会互相覆盖」这个写入侧的理由，读不出「派生 URL 也必须过它」。

**对真实 R2 实测**（`R2_KEY_PREFIX=mememio/`，bucket `mememio-dev`）。列出桶里现存的 4 个对象，用库里那种不带前缀的相对键喂给 `publicUrlFor`，逐个 HEAD：

```
200 image/jpeg   .../mememio/memes/4d92a40e-….jpg     ← url
200 image/jpeg   .../mememio/memes/cad3e99f-….jpg     ← url
200 image/webp   .../mememio/thumbs/4d92a40e-….webp   ← thumbUrl
200 image/webp   .../mememio/thumbs/cad3e99f-….webp   ← thumbUrl
对照（修复前的拼法，少一段 mememio/）：404
```

对照组那条 404 就是今天整页裂图的内容。`tempUrl` 与 `url` 共用同一个函数、同一条前缀路径，桶里当前没有滞留的 `temp/` 对象，所以它是**按同函数推断的，没有单独打开过一个真实的 tempUrl**——单测和集成测试各钉了一条（见下）。

用的核对脚本是一次性的，跑完已删，没进仓库。

### 5.2 测试

**前缀非空是两条测试自己定的，不读 `.env`。** 照抄环境里那个值等于把回归锚点的有效性交给别人的配置文件。

- `api/src/storage/r2.test.ts`（新增，unit）：`stubEnv` 定死 `R2_KEY_PREFIX=r2-public-url-test/` 再动态 import，断言 `publicUrlFor` / `tempUrl` / `url` / `thumbUrl` 四个地址都带前缀。**把 `publicUrlFor` 改回修复前的写法，4 条里挂 3 条**（实际验证过）；剩下那条挂不了，因为它比的是 `out.url === publicUrlFor(storageKey)`，两边一起错就一起过——所以字面量断言和「同一个函数」断言两种都写了，前者防拼错，后者防第二份实现复活。
- `api/tests/import-reviews.test.ts`（改）：文件头把 `R2_KEY_PREFIX` 定死成 `reviews-test/`，新增一条用例断言 `tempUrl` / `existing.url` / `existing.thumbUrl` **反推出的完整键都在桶里真实存在**。这里不用 `toContain('temp/…')`：子串断言在漏前缀时照样过，而这正是本次的 bug。选这个文件是因为它是三个地址唯一同时出现的地方。

`npm test` 全绿：**27 个文件 / 266 条**。`npm run typecheck` 通过。

### 5.3 启动自检（3.2）

做了，没退回。`storage/r2.ts` 新增 `assertR2Reachable()`，`server.ts` 在 env 之后、连库之前调用。

用 `ListObjectsV2` + `MaxKeys: 1` 而不是 `HeadBucket`：Head 响应没有 body，鉴权失败只能拿到一个光秃秃的 403，而「凭证错」和「令牌没授权到这个 bucket」要分开查。

三个约束都落实并**逐个实测**：

| 场景 | 结果 |
|---|---|
| bucket 名拼错 | 拒绝启动，`NoSuchBucket` |
| `R2_ACCOUNT_ID` 粘成整条 endpoint URL | 拒绝启动，报错里 endpoint 显示成 `https://https://….r2.cloudflarestorage.com.r2.cloudflarestorage.com`，一眼能看出粘错了 |
| 凭证错 | 拒绝启动，`SignatureDoesNotMatch`，**响应体里的 AccessKeyId 没有出现在错误信息里** |
| `NODE_ENV=test` | 跳过，不联网 |
| 超时 | 把超时临时压到 1ms 验证 `abortSignal` 真的被 SDK 认，得到 `AbortError`；错误信息里译成「超时 8000ms」，不直接吐 `AbortError` |

错误信息只带 endpoint / bucket / keyPrefix，**只取 `error.name`，不取 `message`、不取原始错误体**（硬边界 SPEC §5.3——S3 的鉴权错误体会回显 AccessKeyId）。

真启动了一次，顺序确认为：词表 → 默认模型 warn → `R2 已连通` → 数据库已连接 → 迁移版本已是最新 → HTTP → 两个 worker。（那次进程最后 `EADDRINUSE` 退出，因为本机 3000 上已经有一个 dev server 在跑，与本次改动无关，且发生在探活之后。）

**这一条有一个需要总管知道的副作用**：从现在起，**本地开发也必须有一个能连上的 bucket**，填占位符起不来。这是刻意的——`env-validation.md §5` 只允许 cookie `Secure` 一处按环境分支，为开发态放行等于新开一个分支，而「配错了不报错」正是这次的病根。代价是 web 单端开发的人也要配 R2。已写进 `docs/environments.md §4`。如果总管认为代价太大，退路是把它降成启动 warn，但那样就回到了「配错了要等浏览器告诉你」。

`env-validation.md §3` 的启动顺序表跟着改了（4 步 → 5 步），否则规则和代码对不上。

### 5.4 文档（3.3）

- `.env.example`：补 `R2_PUBLIC_BASE_URL`（必填、不带末尾 `/`、不要把前缀拼进去），并给 `R2_ACCOUNT_ID` / 凭证两行加了防粘错说明。
- `docs/deployment.md`：新增 **§8 R2：开通、公开访问与 CORS**（8.1 开通与凭证、8.2 公开访问、8.3 CORS、8.4 配错了怎么发现），今天实测有效的 CORS 策略原样收录，两个坑（令牌在 R2 账户级的 Manage API Tokens、`R2_ACCOUNT_ID` 只填 32 位）单独标注。原 §8 落地检查清单顺延为 **§9**，新增 5 条勾选项，包括「真导一张图，在浏览器里打开 `url` 和 `thumbUrl`，看到图而不是 404」。
- `docs/environments.md`：§1 变量清单补 `R2_PUBLIC_BASE_URL`；§4 写明启动探活的后果。
- 章节号顺延只影响一处外部引用（`environments.md` 里的「deployment.md §4 / §8」），已改为 §9。

### 5.5 没做的

- SPEC 一个字没改。`url` / `thumbUrl` / `tempUrl` 的形状和含义都没动，本次修的是它们算错了。
- §4「本次不做」两条照旧不做：checksum 那条今天仍未复现失败，web 的 `uploadToR2` 兜底是 web 单端。
- 没跑评测集——本次没动打标提示词、词表或检索参数。
- **未提交。** 本次授权里没有提交动作，改动留在工作区。建议拆成三次提交：`fix(api): 派生公开 URL 补上 R2 键前缀，删掉第二份实现` / `feat(api): 启动时探活 R2，配错就拒绝启动` / `docs: 补 R2_PUBLIC_BASE_URL 与 R2 开通及 CORS 手册`。

