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
| `images/edge/huge.png` | ❌ **不进** | 23 MB，是「小」这条的唯一例外。`npm run fixtures` 字节一致复现，详见下 |
| `eval/` 的标注 | ✅ 进 | 是文本，且是项目的核心资产 |
| `eval/` 的图片 | ❌ **不进** | 含擦边内容，见 [eval.md](eval.md) |
| `responses/` | ✅ 进 | 脱敏后是纯文本，价值极高，见下 |

> ✅ **新克隆不用手动做任何事。** `tests/global-setup.ts` 在跑测试前比对 `tests/helpers/fixtures.ts` 的 `FIXTURES` 清单，缺哪个补哪个，所以缺 `huge.png` 的新克隆直接 `npm test` 就是全绿。
>
> 为什么单独排除它：其余 17 个样本合计 1.4 MB，它一个 23 MB，进了 git 历史就永久占着，而它的内容是脚本按规则生成的纯噪声——**可复现的大文件不该进版本历史**。
>
> **自动补齐只补缺的，绝不重写已存在的样本**（`generateFixtures('missing')`）。测试路径上重写样本会让「这次跑的和上次跑的是同一批字节」这条保证消失，而它不报错，只是依赖固定哈希的断言开始飘。手动跑 `cd api && npm run fixtures` 仍然是**覆盖**模式，用来重新生成一批。
>
> 动图那一组是唯一需要 ffmpeg 的，且整组带前置判断：只缺 `huge.png` 时不会调 ffmpeg，一个 sharp 就够。`huge.png` 生成出来必须正好 **23,560,841 字节**（`tests/helpers/fixtures.ts` 的 `HUGE_BYTES` 断言它）。

## 3. `images/edge/` 是最值钱的那批

正常图片到处都是，**难找的是会出问题的那些**。这批必须有：

| 文件 | 测什么 |
|---|---|
| `truncated.png` | 半截文件，sharp 应当报错而不是崩 |
| `fake-ext.png`（实际是 GIF） | magic bytes 探测必须赢过扩展名 |
| `zero-byte.png` | 0 字节 |
| `huge.png`（>10MB） | 单文件大小限制 |
| `single-frame.gif` | 「是 GIF 但只有一帧」——`isAnimated` 应当为 false |
| `animated-long.gif`（12 帧） | 帧数多到能排出完整的降帧梯子（10 → 4 → 拼图）。`animated.gif` 只有 4 帧，梯子的第一级跑不到 |
| `animated-many-frames.gif`（240 帧 / 30 个画面） | 抽帧的**量级**样本，也是唯一的**长静止段**样本。采样策略（头部等距 + 尾部偏置）在 4 帧、12 帧上跑不出区别，只有它能把「去重留下静止段的第一帧」和具体帧号钉住。旧实现（每帧一个进程）在它身上要 12.5 秒——几百帧的 GIF 就是「导入卡住 / 打标超时」的来源 |
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
