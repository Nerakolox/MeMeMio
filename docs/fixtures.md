# 固定数据

测试和评测用的图片、标注、假响应放在哪、怎么用。

## 1. 目录

```
docs/fixtures/
├─ images/         测试图片（小、可公开、进仓库）
│   ├─ static/     PNG / JPG / WebP 静图各一
│   ├─ animated/   GIF / APNG / 动态 WebP
│   ├─ edge/       0 字节、截断的、扩展名撒谎的、超大的
│   └─ dup/        同一张图的多个变体，用于去重测试
├─ eval/           评测集标注（见 eval.md）
│   ├─ manifest.json
│   └─ README.md   图片本身不在这里，说明在哪
└─ responses/      各供应商的真实响应样本（脱敏后）
```

## 2. 三类固定数据，规则不同

| 类 | 进仓库？ | 为什么 |
|---|---|---|
| `images/` | ✅ 进 | 小、可公开、测试必须能离线跑 |
| `eval/` 的标注 | ✅ 进 | 是文本，且是项目的核心资产 |
| `eval/` 的图片 | ❌ **不进** | 含擦边内容，见 [eval.md](eval.md) |
| `responses/` | ✅ 进 | 脱敏后是纯文本，价值极高，见下 |

## 3. `images/edge/` 是最值钱的那批

正常图片到处都是，**难找的是会出问题的那些**。这批必须有：

| 文件 | 测什么 |
|---|---|
| `truncated.png` | 半截文件，sharp 应当报错而不是崩 |
| `fake-ext.png`（实际是 GIF） | magic bytes 探测必须赢过扩展名 |
| `zero-byte.png` | 0 字节 |
| `huge.png`（>10MB） | 单文件大小限制 |
| `single-frame.gif` | 「是 GIF 但只有一帧」——`isAnimated` 应当为 false |
| `animated.webp` / `static.webp` | 同一 MIME，一动一静，验证不能靠 MIME 推断 |
| `apng.png` | 扩展名和 MIME 都是 PNG，但它是动图 |

最后三条对应 [SPEC §5.2.2](../spec/05-data-models.md)——`isAnimated` 不能从 `mime` 推断，这批文件就是那条规则的证据。

## 4. `responses/` ——供应商真实响应样本

这是本项目特有的一类固定数据，**价值被严重低估**。

每探测一个供应商，就把它的真实响应存一份（脱敏：去掉 key、去掉 requestId）：

```
responses/
├─ deepseek-v41-flash/
│   ├─ ok-json-mode.json          正常返回
│   ├─ refused-http-451.json      HTTP 层内容策略拒绝
│   └─ refused-in-body.json       200 但正文是拒绝措辞
├─ <某中转服务>/
│   ├─ dimensions-ignored.json    透传了 dimensions 但没生效
│   └─ invalid-json.txt           声称支持 json_object，实际返回 markdown 包裹的 JSON
```

**为什么必须存真的：** [SPEC §2.4](../spec/02-errors.md) 说 `AI_REFUSED` 有三种形态，那三种形态是**观察出来的，不是设计出来的**。自己编造的假响应只会覆盖自己想得到的情况，而真实供应商的花样永远超出想象——「返回 markdown 代码块包裹的 JSON」这种就没人会主动去编。

拒绝形态的判定逻辑必须用这批样本做单元测试。样本从[供应商探测任务](../joint-tasks/2026-09-13-provider-spikes.md)来。

## 5. 固定数据不是万能的

**不要给成功路径也造一堆假响应。** 对 `VisionTagger` 打桩返回一个完美的 `TagResult`，测到的只是「代码能处理自己造的数据」。

假响应的价值集中在**失败和畸形**上，那些是真的难在真实环境里复现的。成功路径靠评测集里的真实调用验证，见 [testing.md](testing.md)。

## 6. 数据库固定数据

不写 SQL 种子文件。用工厂函数：

```ts
const meme = await createMeme({ uploaderId: alice.id, tags: ['猫'] })
```

未指定的字段由工厂填合法默认值。**测试里只写出与该测试相关的字段**——一屏 INSERT 语句里哪个字段是关键，读的人看不出来。

工厂实现见 `api/agents/rules/testing.md`。
