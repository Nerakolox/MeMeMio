# 内容分级独立成第七维 `ratings`（词表 v0.3.0）

**状态**：`in_progress`——2026-09-22 开工。**选型早已拍板**（三个问题是产品负责人 2026-09-22 当面选的），契约已落 SPEC（[§4.3](../spec/04-vocabulary.md) / [§5.2.3](../spec/05-data-models.md) / [§6.3](../spec/06-endpoints.md) / [§6.4.1](../spec/06-endpoints.md) / [§9.23](../spec/09-decisions.md) / [§9.24](../spec/09-decisions.md)，均标 `proposed`），词表已改（v0.3.0）。**两端实现已完成**，验收见文末两节；待办只剩「联合验收通过后归档」。
**性质**：**跨端**——改 `memes` 的列、改接口的可筛字段与响应字段、改词表主源，一端先合入会让另一端坏掉（[§8.2](../spec/08-collaboration.md)）。
**SPEC**：[§4.3](../spec/04-vocabulary.md)（含 §4.3.2 额度）、[§4.4](../spec/04-vocabulary.md)（新增维度的流程）、[§5.2.3](../spec/05-data-models.md) / [§5.2.6](../spec/05-data-models.md)、[§6.3](../spec/06-endpoints.md)、[§6.4.1](../spec/06-endpoints.md)、[§9.23](../spec/09-decisions.md)、[§9.24](../spec/09-decisions.md)（阅览页信息栏）、[§9.5](../spec/09-decisions.md)（为什么模型侧打不出来）

> ⚠️ 迁移是**新列**，没有存量要搬。SQL 只有一句 `alter table`，但**索引要和现有六列一致**（照 `0006` 的写法）——漏索引的表现是筛选能跑、只是全表扫描。

## 为什么要做

产品负责人 2026-09-22：「现在标签没有色色，加上色色的标签，R18」。查证属实：`色情 / 擦边 / 成人 / 露骨 / R18` 在 `vocab.json` 里 grep 全空，190 个词条里一个都不沾。

它不只是「缺一类词」。这一维和已经写在 SPEC 里的两件事直接咬合：

- **[§9.5](../spec/09-decisions.md) 已经认定境内模型对这类内容会拒**，而且「是合规问题，不是能力问题，调提示词绕不过去」。所以这一维的打标主力是**人工**，模型能打出来是用户自配模型的运气，不是系统的保证。
- **模型拒了的那批图正好是最需要人工补标签的**（`refused`：无语义描述，靠 OCR 和人工标签）。也就是说「给 R18 图打标签」和「人工补标签的入口」天然是同一件事，而后者现在只有编辑面板一条路（`/tagging` 的补标签还没做）。

## 三个选型（已定，理由记在 [§9.23](../spec/09-decisions.md)）

| 问题 | 结论 | 一句话理由 |
|---|---|---|
| 形态 | **新增第七维 `ratings`** | 两端读同一份 `VOCAB_FIELDS`，校验 / 筛选 / 编辑 UI 自动跟着走，代价只有一次 DDL |
| 可见性 | **不动**，和别的图一样默认可见 | 隐藏是**读路径**决策，捆进一次词表变更会让它变成权限变更 |
| 粒度 | **一个词**：「成人向」 | 细分是兼容变更（新增词条，可直接合入），想加随时加；先细分再合并才要迁移 |

**字段名 `ratings`、UI 名「内容分级」、词条「成人向」是总管定的**，都是可推翻的细节——推翻了要改的是 SPEC 那张表 + `vocab.json` 一个字符串。

## 词表变化（v0.2.0 → v0.3.0，`proposed`）

| 项 | 变化 |
|---|---|
| 维度 | 六 → **七**（`ratings` 排在最后：语义维度 → 内容维度 → 分级） |
| 词条 | 190 → **191**（只多「成人向」） |
| alias | **+7**：`色色` / `涩涩` / `色情` / `R18` / `r18` / `NSFW` / `nsfw` → `成人向` |

alias 那七个是**猜测**，赌模型会吐这几个词。它们不影响人工（编辑界面只能从列表里选），只影响模型输出的归一化。赌错了的代价是零（多几条永不命中的映射），赌对了省一轮「词表外标签」的失败重试。`3D` / `ddl` / `capybara` 这些非中文 alias 早就在文件里，所以英文键不违反 §4.3.2——那条约束管的是**词条**。

> ⚠️ **已实测：光改词表就把 api 测试跑红了。** 只管改 `vocab.json`、不碰 api 代码时，`npx vitest run src/vocab.test.ts` = **13 passed / 1 failed**，红的是 `别名的目标必须是某个维度里真实存在的词条`——7 个 alias 全部报 dangling（`色色 → 成人向` …）。
>
> 原因是 api 侧的 `VOCAB_FIELDS` 还没有 `ratings`，于是 `isKnownTerm('成人向')` 为 false。**这是这条任务必须两端一起合入的实证**，不是流程上的谨慎：`vocab.json` 是两端共读的主源，只改它等于同时改了 api 的输入而没有更新 api 的断言。api 端把 `ratings` 加进 `VOCAB_FIELDS` 后这条测试自动转绿，不需要改测试本身。
>
> 所以本任务落地的顺序是：**api 端一次改完（词表已在树上 + `VOCAB_FIELDS` 等）→ web 端跟上**。中间不要切一个只有 `vocab.json` 的提交进主干。

## 做完的标准

**api 端**

- 迁移在一次性库上跑通；`ratings` 列与其余六列**同一种索引**
- `npx vitest run` 全绿（含新维度进 `vocab.test.ts` 的互斥 / alias 断言）
- `GET /memes` 响应里有 `ratings`（空数组，不是 `null`、不是缺席）
- `PATCH /memes/{id}` 能改它；词表外的值 → `VALIDATION_FAILED`（**不是** `AI_INVALID_OUTPUT`）
- `GET /memes?ratings=成人向` 能筛；`?ratings=色色` 走 alias 归一化后也**不该**匹配（alias 用于**模型输出**，不是查询参数——若实现成查询也归一化，要在任务里写明这是有意扩展）
- 模型输出缺席 `ratings` → 按空数组处理，**不是失败**（老提示词、别的模型都会这样）
- 提示词里那一问的措辞是**中性**的（只问「是不是成人向」+「不确定留空」，不描述内容）
- **跑评测集**：按 [§4.4](../spec/04-vocabulary.md) 改词表必须跑；现在有前置欠账（标注还是两维口径），跑不了就**直说没跑**并记在这里

**web 端**

- 筛选栏多一段「内容分级」，编辑面板多一段同名的分区
- 编辑面板能打上「成人向」并保存，且 `PATCH` 的 body 里**只有**改动的那一维
- `npm run typecheck` + `npm run build` 过
- **在真浏览器里开过**——这页上次的欠账就是「只在浏览器外验过」，而它当场就出了「描述以下全空白」

## api 端要改什么

| 文件 | 改什么 |
|---|---|
| `src/vocab.ts` | `Vocabulary` 类型加 `ratings: string[]`；`sets` 加一项；`VOCAB_FIELDS` **末尾**加 `'ratings'`；`vocabularySize` 加一项。`termsOf` 不用动（只有 `tags` 有分组） |
| `src/lib/vision-output.ts` | `TagFields` 加 `ratings`；`VocabField` 加 `'ratings'`；`LABEL_FIELDS` 加。⚠️ 加进 `LABEL_FIELDS` 就自动进了 `buildSearchText`（**embedding 的输入**）——这是**有意**的，「成人向」进向量对检索有利，但要留意 embed 供应商对这类词的处理 |
| `src/ai/vision.ts` | 提示词：「八个键」→ 九个键、维度说明加一行、额度加「ratings 最多 1 个」、词表段落加 `ratings = 成人向`、输出格式示例加 `"ratings":[]`。**措辞中性** |
| `src/data/schema.ts` | `ratings: text('ratings').array()` |
| `migrations/0007_*.sql` + `meta/` | `alter table memes add column ratings text[]` + 索引。**照 `0006` 的写法抄**，别自己发明。没有 data 迁移 |
| `src/serialize/meme.ts` | `ratings: row.ratings ?? []`（同其余六列那句注释一起改） |
| `src/data/memes.ts` | 写路径（插入 / PATCH 组装 / `search_text` 重算）与读路径都是 `VOCAB_FIELDS` 驱动，**大概率不用改**。⚠️ 真正要做的是**核对**：哪里手写了六列（而不是遍历 `VOCAB_FIELDS`），就是漏点。 `listMemes` 的注释里那句「六维一视同仁」也要改 |
| `src/data/search.ts` | 遍历 `VOCAB_FIELDS`，自动带上。确认标签路的 OR 展开变成七个 |
| `tests/**` | `vocab.test.ts` / `vision-output.test.ts` / `vocab-match.test.ts` / `tag-queue*` / `search-*` / `meme-edit-delete` 里凡是枚举六个字段、或断言「每维至少 N 个词条」的都要跟着动。**`ratings` 只有一个词条，最容易踩的就是空维度/下限断言** |

## web 端要改什么

好消息：**三处**，其余自动。

| 文件 | 改什么 |
|---|---|
| `src/lib/vocab.ts` | `Vocabulary` 类型加 `ratings: string[]`；导出 `ratingOptions`；`VocabField` 加 `'ratings'`；`VOCAB_DIMENSIONS` 末尾加 `{ field: 'ratings', label: '内容分级', options: ratingOptions }` |
| `src/lib/api-contract.ts` | 形状断言里补 `ratings: []`——它存在的意义就是证明服务端**真的**把新字段序列化出来了 |
| — | 改完这两处，`VOCAB_FIELDS` / `MemePatch` / `FetchMemesParams` / `VocabSections` / `BrowseFilters` / `MemeEditPanel` 全部跟着走 |

两个**不要做**的：

- **不要为这一维把 chip 换成开关。** §9.23 记着「不是开关」那条裁定（多选维度换开关会把语义说成开/关）。一个词的 chip 组看起来像开关，但它仍是「选了/没选」，且将来加第二个词时不用重做。
- **不要给这一维在卡片上加角标。** 那是可见性决定，本次明确不做（[§9.23](../spec/09-decisions.md)）；要做是另一次决策。

### 追加范围：阅览页信息栏（2026-09-22 加）

用户的追问是「那个 R18 的标签在阅览页面我怎么没看见呢」，查证后发现缺口比这一维大：**全屏阅览器只渲染图片本身**（`src` / `alt` / 宽高），一条元数据都不显示，而 `MemeCard` 也从不显示标签值。所以这一维能存能筛能改，**就是看不见**。裁定记在 [§9.24](../spec/09-decisions.md)。

边界要写清楚，免得和上面两条「不要做」打架：

| | |
|---|---|
| **不做卡片角标** | 仍然不做。角标是扫视时的信号，本次不加 |
| **做阅览页信息栏** | 加在**已经决定要看这张**的场合，显示标签值（`ratings` 排首）/ 描述（截断 2 行）/ `@uploaderName` |

改动落在两个文件：

| 文件 | 改什么 |
|---|---|
| `src/components/yarl-augment.d.ts`（新增） | 声明合并给 YARL 的 `GenericSlide` 挂一个 `meme?: Meme`。**不能用 `as` 强转**（`code-style.md` 禁、`web/src/` 下零命中），字段也**不能叫 `description`**（captions 插件占用了这个名字） |
| `src/components/ImageViewer.tsx` | `toSlide` 挂上整条 `meme`；新增 `SlideFooter` 接到 `RENDER.slideFooter`。`RENDER` **仍是模块级常量**——footer 的 props 只有 `{ slide }`，数据随 slide 走，所以不存在「`slides` 换了、`render` 没换」的节奏问题，也绕开了浅合并丢 `buttonPrev/Next` 那个坑 |

## 风险与观测项

| 项 | 说明 |
|---|---|
| **提示词多问了一问** | 「这张图是不是成人向」对**无害的图也问**。这可能提高整体被拒率，不只是 R18 那几张——[§9.23](../spec/09-decisions.md) 记了这条**没有实测支撑**。判定它必须看真实拒绝率（`GET /memes/tag-status` 的 `failures`），不能看几张图 |
| embedding 里出现「成人向」 | `buildSearchText` 拼进向量输入。预期是好处（语义检索更容易命中），但 embed 供应商若对这一类词有过滤，表现是**那几张图向量化失败**（`embed_failed`），不是报错 |
| alias 是赌的 | 见上文。赌错代价为零 |
| 评测集 | **跑不了**（前置欠账）。这一维的模型侧准确率因此**没有数据**，不要在任何地方声称它被验证过 |

## 等你拍板的两件小事

1. **字段名与词条**：`ratings` / 「内容分级」/「成人向」。不喜欢就现在说，改的是一个字符串；实现之后改就要动迁移。
2. **alias 那七个**要不要留（`色色` `涩涩` `色情` `R18` `r18` `NSFW` `nsfw`）。留着的唯一代价是文件长一点。

## api 端验收

**状态**：2026-09-22 开工并完成。以下都是实测，不是设计陈述。

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | **33 files / 375 tests 全绿**（真库、无 mock） |
| 迁移 0007 | 对真库跑通。SQL 只有两句：`ALTER TABLE "memes" ADD COLUMN "ratings" text[]` + `CREATE INDEX "memes_ratings_idx" … USING gin ("ratings")`。**没有 data 迁移、没有重算 `search_text`**——新列对存量全 NULL，`buildSearchText` 输出不变 |
| `GET /memes` 有 `ratings` | `serialize/meme.ts:97` 的 `ratings: row.ratings ?? []`（空数组，不是 `null`、不是缺席） |
| **那个静默漏点有哨兵** | `tests/tag-queue.test.ts:176` 的样本带了 `ratings: ['成人向']`，`:222` 断言 `row.ratings` 等于写入值——**查的是列真的被写了**，不是「序列化时补了个 `[]`」。`:230` 另断言它进了 `search_text` |
| 标签路第 7 条 | `tests/search-paths.test.ts:152` |
| 词表外值 → `VALIDATION_FAILED` | `tests/meme-edit-delete.test.ts:257`（不是 `AI_INVALID_OUTPUT`） |
| 检索样本池 | `src/lib/vocab-match.test.ts:32` 把 `ratings` 拼进 `allTerms()`，否则这一维永远不进 `pick()` 的样本 |

**没有数据的**：评测集跑不了（标注还是两维口径），所以**这一维的模型侧准确率没有数据，不要声称验证过**。提示词多问的一问是否会抬高整体拒答率，同样没有数据——判定条件写在 [§9.23](../spec/09-decisions.md)。

## web 端验收

**状态**：2026-09-22 完成。用零依赖桩 + 系统 Chrome（`--headless=new`）在 **1264×860（桌面）与 390×844（真移动视口，走同源 iframe 绕开 Chrome 500px 窗口下限）** 两档跑过。

### 阅览页信息栏（Part C，SPEC §9.24）

两档都：`cardCentered: true`、`hOverflow: false`、标签行 `ratings` 排首、`descLines: 2` 且 `descTruncated: true`、`@uploaderName` 在位。

| 档 | 卡片矩形 | 关闭路径 |
|---|---|---|
| 1264×860 | `[288,699,672,94]`（占高 11.7%） | 背景左 / 右 / 底边 padding / `Esc` / `×` 全通；点在卡片上**不关** |
| 390×844 | `[12,719,366,114]`（占高 13.5%） | 同上，另加顶部空白（窄屏图上留白，桌面那张图盖住了） |

- **左右箭头没有回来**：`yarl__button` 只有 `[放大, 缩小, 关闭]`
- **深色**：`--force-prefers-color-scheme=dark` 在这台 headless 上**静默无效**（探针量到 `darkMode: false`、`themeBg` 仍是白），所以改走 CDP `Emulation.setEmulatedMedia` 重跑，`darkMode: true`、`themeBg: oklch(14.5% 0 0)`，卡片矩形与浅色逐字相同。信息栏自身不借主题 token（`bg-black/70` + 白字），对比度由**最坏的纯白底图**决定：`#4d4d4d` 上纯白 8.1:1、`text-white/75` 5.3:1，都过 AA

### 筛选栏与编辑面板（Part B）

- 筛选栏第七段「内容分级」在位，`成人向` chip 选中后 URL 变 `?ratings=成人向`，且**确有其请求**：`GET /api/v1/memes?ratings=%E6%88%90%E4%BA%BA%E5%90%91`
- 编辑面板：`内容分级` 段**默认展开**（有值的维度就是这样），chip `aria-pressed` 由 `true` 切到 `false`，「保存」由禁用转为可用
- **`PATCH` body 逐字是 `{"ratings":[]}`，键只有 `ratings` 一个** —— 「只发改动那一维」实测成立

### 一条没查清的观察（不是结论，别当缺陷用）

在上面那条编辑流程里量到：弹窗内容（Sheet）`pointer-events` 算出来是 `none`，`elementFromPoint` 打在「保存」上返回的是遮罩；同时那个**已经关掉的下拉菜单仍挂在 DOM 里**（`data-state="closed"`）。同一环境下：

- 单独开菜单再按 `Esc` 关 → 菜单**正常卸载**，`body` 的 `pointer-events` 回到 `auto`
- 从同一个菜单走「删除」→ AlertDialog 的内容是 `pointer-events: auto`
- 探针自检：这个环境**跑 CSS 动画**（`animationend` 会来），不是「动画不跑导致 Presence 不卸载」

所以它**只出现在「菜单 → 编辑 → Sheet」这一条**，而我的交互是页面内合成事件（CDP 真实输入那一路没能在菜单上打开，另一条没走通的路）。**它到底是应用缺陷还是合成事件的假象，我没能分开**——要一个真人用鼠标点一下编辑面板就能判定。**没有据此改任何代码。**

> 这个面板上一次的欠账正是「只在浏览器外验过」，所以这里把没查清的部分也留着，而不是记一句「已验收」。
