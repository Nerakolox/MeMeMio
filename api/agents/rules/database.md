# 数据库

表结构见 [SPEC §5](../../../spec/05-data-models.md)。本文是实现约束。

> ⚠️ **本项目三条硬边界里的两条在这个文件里。改 `data/` 之前必须读完。**

## 1. `memes` 只有一个入口

所有 `memes` 的读写走 `data/memes.ts`，**不允许在别处写涉及 `memes` 的 SQL**。

这不是洁癖。下面两条保证只有在「唯一入口」成立时才成立：

### 1.1 读：强制 `deleted_at is null`

每一个查询方法都带。**不靠调用方记得传参数**——默认就是过滤掉，想要软删记录必须显式调用另一个方法：

```ts
findMemeById(id)                  // 永远不返回软删的
findMemeByIdIncludeDeleted(id)    // 管理员「已删除」视图专用
```

方法名带 `includeDeleted` 是故意的：**它在 code review 里必须是显眼的**。

漏掉这个过滤的表现是「删掉的图又出现了」，**不报错、不崩溃**。它比漏权限检查更隐蔽，因为没有任何信号。

搜索的三路（`pg_trgm`、标签、向量）是**分别写的三段 SQL**，三段都要带。这是最容易只改一处的地方。

2026-09-26 起，**筛选条件本身只有一份**：`data/memes.ts` 的 `memeFilterConditions` / `memeQueryConditions`，
浏览与检索三路共用（抽出来之前浏览与检索各写一遍，漏一个条件的表现是「我明明筛了」而不是报错）。
共用的是**条件的构造**，不是 `WHERE`：每一路仍然要把它真的接进自己的 `.where()`——三路各写一遍
`.where()` 是这个文件里唯一留着的那处重复，改的时候三处都要看。

### 1.2 写：强制 `assertCanMutate`

```ts
assertCanMutate(meme, actor, action)   // action: 'edit' | 'delete' | 'retag'
```

判断在函数内部，**调用方不自己拼条件**。三个 action 的规则不同：

| action | 谁可以 |
|---|---|
| `edit` | **所有登录用户** |
| `delete` | 上传者或管理员 |
| `retag` | 上传者或管理员 |

`edit` 全员开放是[有意的不对称](../../../spec/09-decisions.md)，不是漏写。**不要"顺手补一个归属检查"**——那会把共享库最核心的一条产品决策改掉。

**风险在写路径，不在读路径。** 共享库里全库可读是设计本身，没有可泄露的边界；但删除接口漏一个归属检查，等于任何人都能删掉别人的贡献。不要把隔离式多租户的直觉搬过来。

### 1.3 本节只管 `memes`

`search_snapshots`（[retrieval.md §6](retrieval.md)）**不是 `memes` 的一部分**，它有自己的
`data/search-snapshots.ts`，就像 `tag_jobs` 有自己的访问方法。所以「所有 `memes` 的 SQL 走
`data/memes.ts`」这条**不要读成「`data/` 下只能有一个文件」**；反过来，也不要把别的表的
SQL 塞进 `memes.ts` 图省事。

它豁免的只是 §1 这一组**仅对 `memes` 成立**的保证（软删过滤、`assertCanMutate`）。
`users` 外键上的 `on delete cascade`、过期行的清理都写在它自己的文件里。

## 2. 向量

```ts
// 截断后必须重新归一化，否则余弦相似度静默失真。见 SPEC §9.6
const v = l2Normalize(raw.slice(0, 1024))
```

**忘记 `l2Normalize` 不会报错**，只会让搜索结果慢慢变差，几周后才在评测集上暴露。这是本项目最隐蔽的一个 bug 形态，[必须有单测](../../../docs/testing.md)。

优先走供应商的 `dimensions` 参数（服务端直接返回 1024 维），不支持时才客户端截断。走哪条由 `embed_config.dim_param_works` 决定——**那是测试连接实测出来的，不是猜的**。

索引用 HNSW。共享库没有 `WHERE user_id = ?` 这个过滤条件，HNSW 跑在最舒服的状态；`deleted_at is null` 选择率接近 1，不构成同类问题。

## 3. pHash 查询

全库直接扫，不建 BK-tree：

```sql
select id, bit_count(phash # $1) as distance
from memes
where deleted_at is null and bit_count(phash # $1) <= $2
order by distance
limit 10;
```

`#` 是 XOR。几万行仍在毫秒级，到十万量级再考虑专用结构。**现在就上专用索引是提前优化**。

> ⚠️ **上面是示意，真实实现拆成了两个 32 位半边**（`data/memes.ts` 的 `findNearestByPhash`）。
> 两处不能省：`bit_count` 在 PG 17 上没有 `bigint` 重载；半个哈希**必须按有符号 int4 传**。
> dHash 是 64 位满的，两个半边各有一半概率超过 2147483647，当无符号传进去
> `$1::int` 会在 Bind 阶段就报 `value "3480189747" is out of range for type integer`——
> 库里一行都没有照样炸，表现是「导入几乎每张图都失败」。同理 `phash` 落库前也是有符号 64 位，
> 由 `lib/phash.ts` 的 `dHashFromGray` 直接产出，**不要在中间「把负数改回正数」**。

> ⚠️ **`phash` 上不能加唯一约束。** 它只是普通 btree 索引。加了会硬性挡掉 Hamming 距离为 0 的情况，而那恰恰可能是用户看过之后决定要保留的不同图——判断权在人，DB 不能先斩后奏。见 [SPEC §9.7](../../../spec/09-decisions.md)。
>
> 反过来，`content_hash` 的 `unique` 是硬约束，不能降级。

## 4. 迁移

`drizzle-kit`，独立命令，**不在容器启动流程里自动跑**。理由见 [`docs/deployment.md`](../../../docs/deployment.md)。

不改已合入的迁移文件。

新建表时检查清单：

- [ ] 时间字段是 `timestamptz`，不是 `timestamp`
- [ ] 外键命名 `<单数资源名>_id`
- [ ] 涉及 `memes` 的查询条件里有没有 `deleted_at`
- [ ] 需不需要加进备份说明

## 5. 事务

「写 `memes` + 入队打标」必须在同一个事务里。

这是[不用 Redis](../../../spec/09-decisions.md) 换来的最大好处——「图片入库了但队列任务丢了」这类不一致根本不可能发生。**别为了"性能"把它拆开**，拆开就白放弃 Redis 了。

R2 的对象操作**不能**进事务（它不在数据库里）。顺序是：先写 R2，再写库；失败时留下的孤儿对象由定时清理处理。反过来会出现「库里有记录但文件不存在」，那个用户能看见。
