# 测试

测什么、不测什么见 [`docs/testing.md`](../../../docs/testing.md)。本文是 `api` 端的写法约束。

## 1. 工具

`vitest`。集成测试用**真 Postgres**（testcontainers 或本地 db），不用 mock、不用 sqlite。

本端重度依赖 `pgvector`、`pg_trgm`、`bit_count`、`FOR UPDATE SKIP LOCKED`——**这些全都无法 mock**，mock 掉之后测的就不是真实行为。

## 2. 每个测试自己建数据

工厂函数，不写 SQL 种子文件：

```ts
const alice = await createUser({ role: 'member' })
const meme  = await createMeme({ uploaderId: alice.id, tags: ['猫'] })
```

未指定的字段由工厂填合法默认值。**测试里只写出与该测试相关的字段**——一屏 INSERT 语句里哪个字段是关键，读的人看不出来。

不依赖全局种子数据。共享种子会让「这个测试为什么挂」需要翻到另一个文件才能回答。

每个测试用例后回滚事务或清表，**不靠测试之间的执行顺序**。

## 3. 打桩的边界

| 打桩 | 不打桩 |
|---|---|
| `VisionTagger` / `Embedder` | 数据库 |
| R2 客户端 | `lib/` 里的纯函数 |
| 时钟（测清理任务时） | ffmpeg / sharp（用真文件，见下） |

**AI 的桩只用来测失败路径。** 给 `VisionTagger` 打桩返回一个完美的 `TagResult`，测到的只是「代码能处理自己造的数据」；真正的价值在于用 [`docs/fixtures/responses/`](../../../docs/fixtures.md) 里的**真实畸形响应**驱动降级逻辑。

图像处理用 [`docs/fixtures/images/`](../../../docs/fixtures.md) 里的真文件，不打桩——损坏文件、假扩展名、单帧 GIF 这些的行为无法靠桩复现。

## 4. 必须有的测试

完整清单见 [`docs/testing.md`](../../../docs/testing.md)。本端**不写就算没做完**的几组：

**软删** —— 搜索三路各自都过滤（三路是分开写的 SQL，最容易只改一路）；恢复后收藏关系还在。

**权限** —— 非上传者**编辑成功**（这条是有意的不对称，最容易被"顺手补一个检查"改坏）；删除被拒；三个 `action` 各测一遍。

**去重** —— Hamming 距离为 0 但内容不同的两张图**都能建记录**（测的是 `phash` **没有**唯一约束）。

**向量** —— 2560 维截断到 1024 后 L2 范数为 1（误差 1e-6 内）。这个 bug 完全静默，只有测试能抓到。

**AI 降级** —— [三种拒绝形态](ai-providers.md)各触发一次，尤其是「JSON 结构完整但字段全空」那种。

**词表** —— 人工编辑提交词表外标签也被拒（不能只挡模型）。

## 5. 断言要具体

```ts
// ✗ 过了也不知道过的是什么
expect(res.status).toBe(403)

// ✓ 错误码是契约的一部分
expect(res.status).toBe(403)
expect(body.error.code).toBe('FORBIDDEN')
```

错误码变了前端会坏，所以断言必须断到 `code`。**`message` 措辞不要断言**——那是可以自由改的。

## 6. 不进 CI 的

[评测集](../../../docs/eval.md)不进 CI。它回答「准不准」，结果是分数不是断言，会随模型和提示词浮动——**一次供应商侧的静默模型升级就会让它红，而那不是代码坏了**。

评测集手动跑，结果记在任务里。测试进 CI，红了就是坏了。

真实 AI 调用、真实 R2 上传同理，不进 CI。
