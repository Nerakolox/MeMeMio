# §5 数据模型

[返回索引](INDEX.md)

数据库使用 snake_case，接口使用 camelCase，见 [§7](07-naming.md)。本章给出结构与语义；索引和迁移的实现约束见 `api/agents/rules/database.md`。

## §5.1 User 与邀请

```sql
users(
  id                   uuid primary key,
  role                 text not null default 'member',   -- 'admin' | 'member'
  storage_quota_bytes  bigint not null,
  created_at           timestamptz not null
);

invite_codes(
  code        text primary key,
  created_by  uuid not null,
  used_by     uuid,
  used_at     timestamptz,
  expires_at  timestamptz
);
```

对外表示：`{ id, role, storageQuotaBytes, storageUsedBytes, createdAt }`。`storageUsedBytes` 是实时聚合出来的，不是存储字段。

## §5.2 Meme

共享库主表。**检索时不按归属过滤**，`uploader_id` 只用于写权限判断。

```sql
memes(
  id            uuid primary key,
  uploader_id   uuid not null,        -- 上传者，不是「拥有者」

  -- 存储与去重
  storage_key   text not null,        -- R2 对象键
  original_filename text,             -- 上传时的原始文件名，不可信，仅参与 trgm
  content_hash  text not null,        -- SHA-256 hex
  phash         bigint not null,      -- 感知哈希
  mime          text not null,
  width         int,
  height        int,
  size_bytes    bigint not null,
  is_animated   boolean not null,

  -- AI 产出
  ocr_text      text,
  description   text,
  expressions   text[],              -- 面部表情，视觉事实
  emotions      text[],              -- 情绪
  tones         text[],              -- 表达语气
  purposes      text[],              -- 聊天用途
  scenes        text[],              -- 生活情境
  tags          text[],              -- 主体与风格
  ratings       text[],              -- 内容分级（成人向），不是语义维度
  search_text   text,                -- 上述字段拼接，供 embedding 使用
  embedding     vector(1024),

  -- 溯源
  vision_model  text,
  embed_model   text,
  tag_status    text not null,        -- pending | ok | refused | needs_manual
  edited_by     uuid,
  edited_at     timestamptz,

  deleted_at    timestamptz,
  created_at    timestamptz not null
);
```

### §5.2.1 去重字段

`content_hash` 有**全局唯一约束**，字节完全相同的文件不可能出现两条记录。

`phash` **刻意不是唯一约束，只建普通索引**。它会误判——同一模板换了字的两张表情包 Hamming 距离可能很近，但它们是两张不同的图。近似判断交给用户，DB 不能先斩后奏。理由见 [§9.7](09-decisions.md)。

两者都是全局作用域，不含 `uploader_id`：两个人传了同一张图，公共库里不该出现两条记录。

### §5.2.2 `is_animated`

前端复制 / 下载分流的唯一依据，不能靠 `mime` 推断——WebP 和 APNG 都可能是动图也可能是静图。

浏览器剪贴板只保证 `image/png`，动图写不进去。前端必须据此分流，不能让用户点了 GIF 之后发现没反应。能力边界见 [§9.2](09-decisions.md)。

### §5.2.3 AI 产出字段

单次视觉调用产出全部字段，不做独立 OCR 链路。**七个数组字段的取值必须落在 [§4](04-vocabulary.md) 对应维度的词表内**，且五个语义维度之间不互相推导——判据见 [§4.3.1](04-vocabulary.md#431-维度之间不能互相推导)；`ratings` 不是语义维度、不适用那条判据（[§4.3](04-vocabulary.md)）。**`ratings` 允许缺席**：老提示词 / 不认识这一维的模型不会回这个键，缺席按空数组处理，不是失败。

`search_text` 是 `ocr_text` + `description` + 七个数组拼接的结果，**供 embedding 使用**。它是派生字段，任何一个来源字段变更时必须重算。

> ⚠️ **`pg_trgm` 匹配的是 `ocr_text` + `description` + `original_filename`，不是 `search_text`。**
>
> 两者刻意不同。标签值已经由标签通路精确命中一次，如果再让它们出现在文本通路的匹配目标里，同一个词会在 RRF 融合前被两条通路各算一次分——一张靠标签沾边的图会压过一张原文精确命中的图。**文本通路只管文本，标签通路只管标签。** 见 [§9.21](09-decisions.md)。
>
> `original_filename` 的待遇则相反：**它参与 `pg_trgm`，但不进 `search_text`，因此不进 embedding。** 存下来的理由是从网上保存的表情包文件名里常带梗名，那是梗名最便宜的来源之一（见 [§9.18](09-decisions.md)）；不进 embedding 的理由是大量文件名是 `IMG_1234.jpg`、`微信图片_20240101.jpg` 这类纯噪声，混进向量只会稀释语义。

`original_filename` 是用户提供的字符串，**和 `mime` 一样不可信**：不据此判断格式、不用于构造任何路径、入库前限长并去掉控制字符。它对应 §5.2.6 的 `originalFilename`，前端在图片加载失败时用它兜底显示。

`tag_status`：

| 值 | 含义 | 可否被搜到 |
|---|---|---|
| `pending` | 尚未打标（未配模型，或排队中） | 只能按文件属性浏览 |
| `ok` | 打标成功 | 全部三路 |
| `refused` | 主副通道都被拒绝 | 无语义描述，靠 OCR 和人工标签 |
| `needs_manual` | 需要人工补，在待处理列表里 | 同上 |

### §5.2.4 `embedding`

全站固定 1024 维。**不是每条记录的属性**，所以表里没有 `embed_dim` 字段。

`embed_model` 保留，用于管理员更换模型后找出待重算的记录，**同时是向量通路的召回条件**——见 [§6.3.1](06-endpoints.md#631-搜索) 与 [§9.20](09-decisions.md)。全站统一 embedding 的理由见 [§9.6](09-decisions.md)——这是共享库带来的硬约束，不是可调参数。

### §5.2.5 软删

`deleted_at` 非空即已删除。所有常规读路径必须过滤，见 [§3.4](03-auth-permission.md)。

R2 上的原图延迟清理：软删满 30 天后由定时任务物理删除，此时才从配额中释放。

### §5.2.6 对外表示

```
{
  id, uploaderId, uploaderName,
  url, thumbUrl,            // 由 storageKey 派生的访问地址，不返回 storageKey 本身
  mime, width, height, sizeBytes, isAnimated, originalFilename,
  ocrText, description,
  expressions[], emotions[], tones[], purposes[], scenes[], tags[], ratings[],
  tagStatus, visionModel,
  favorited,                // 当前登录用户是否收藏，见 §5.4
  editedBy?, editedAt?, createdAt
}
```

**不返回**：`contentHash`、`phash`、`embedding`、`searchText`、`embedModel`、`deletedAt`、`storageKey`。它们是内部字段，客户端没有消费场景。

**上面那份清单就是「展示全部图片信息」的上限。** 编辑面板想显示得越全，越容易滑向「再要一个字段」——`phash` 和 `embedding` 对用户没有任何可读的含义，`storageKey` 是应该被派生 URL 取代的东西。**不要为了把面板填满去加接口字段**：这份清单里没有的，就是界面上不该出现的。

## §5.3 AI 配置

视觉配置每人一份，Embedding 配置全站一份。两者待遇不同的理由见 [§9.3](09-decisions.md) 与 [§9.6](09-decisions.md)。

```sql
user_ai_configs(
  user_id                 uuid primary key,

  vision_base_url         text,
  vision_api_key_enc      bytea,        -- AES-GCM，主密钥在 CONFIG_ENC_KEY
  vision_model            text,

  vision_fb_base_url      text,         -- 副通道，可空
  vision_fb_api_key_enc   bytea,
  vision_fb_model         text,

  -- 「测试连接」探测结果，不由用户填写
  vision_json_mode_works  boolean,
  vision_multi_image      boolean,
  verified_at             timestamptz
);

-- 全站单行表
embed_config(
  id               int primary key default 1 check (id = 1),
  base_url         text,
  api_key_enc      bytea,
  model            text,
  native_dim       int,                 -- 实测输出维度
  dim_param_works  boolean,             -- dimensions 参数是否生效
  verified_at      timestamptz
);
```

探测结果字段**不接受客户端写入**——它们只能由测试连接接口写入。用户手填的「支持多图」不算数，见 [§9.7](09-decisions.md)。

对外表示的密钥字段固定为 `"****" + 后四位`，且回传该字符串视为「不修改」，见 [§3.5](03-auth-permission.md)。

配置为空时回退到部署方的环境变量默认值。对外表示包含 `source: "user" | "default"`，让用户知道当前用的是哪一套。

## §5.4 收藏

收藏是**人和图的关系**，不是图的属性。共享库里它必须独立成表，否则 A 收藏了 B 也会看到收藏态。

```sql
user_favorites(
  user_id     uuid not null,
  meme_id     uuid not null,
  created_at  timestamptz not null,
  primary key (user_id, meme_id)
);
```

Meme 的对外表示里 `favorited` 字段是针对**当前登录用户**计算的，不是全局计数。首期不返回收藏总数，也不参与排序。

软删不级联删除收藏记录——恢复一张误删的图时，原来收藏它的人应该还在收藏列表里看到它。物理删除时才级联。

## §5.5 导入批次

```sql
import_batches(
  id          uuid primary key,
  user_id     uuid not null,
  total       int not null,
  created_at  timestamptz not null,
  expires_at  timestamptz not null      -- created_at + 24h
);

import_items(
  batch_id          uuid not null,
  file_name         text not null,
  result            text,               -- imported | exact_dup | needs_review | failed
  meme_id           uuid,               -- 命中或新建的记录
  similar_to        uuid,               -- needs_review 时指向库里相似的那张
  distance          int,                -- needs_review 时的 Hamming 距离
  temp_storage_key  text,               -- needs_review 时文件暂存的 R2 键
  reason            text,
  primary key (batch_id, file_name)
);
```

批次元信息 24 小时后清理，但 **`needs_review` 的条目在用户处理前不清理**——它是待办，不是日志，见 [§6.2.3](06-endpoints.md)。

待确认的文件已经在 R2 上（前端预签名直传），暂存在 `temp/` 前缀下，`temp_storage_key` 指向它。用户选「仍然导入」时移到正式前缀并建 `memes` 记录；选「跳过」时删除该对象。**超过 7 天未处理的待确认条目连同暂存对象一起清理**，避免 temp 前缀无限增长——清理前不需要再问用户，跳过是默认行为。

## §5.6 运行参数

> **状态：`accepted`**（2026-09-23）。新增能力，两端已确认契约、实现已落两端。**尚未转 `stable`**——联合验收还差真 api × 真浏览器的联调，见[运行参数任务](../joint-tasks/2026-09-23-runtime-config.md)的「总管裁定」。

全站单行表，仅 `admin` 可改（[§3.3](03-auth-permission.md)）。它装的是**保护机器**的那几个数——并发上限——**不装产品语义参数**：帧数、送 AI 的长边、去重阈值仍然留在代码常量里，判据见 [§9.26](09-decisions.md)。

```sql
runtime_config(
  id                     int primary key default 1 check (id = 1),
  tag_concurrency        int,        -- 本进程打标在途任务数上限
  tag_per_user_inflight  int,        -- 本进程内每个用户的在途上限
  import_concurrency     int,        -- 单批次导入管线并发
  ffmpeg_concurrency     int,        -- 本进程 ffmpeg 子进程上限
  updated_by             uuid,       -- 谁改的
  updated_at             timestamptz
);
```

**列可空，`NULL` 表示「用代码默认值」。** 空表、空行、空列都是正常状态，不是「未初始化」——刚部署的站一次都不配，行为与常量时代逐字相同。保存时**等于默认值的输入归一成 `NULL`**：显式存一个 `2` 会在将来默认值改成别的数时把它钉住，而界面上看不出「这是被钉住的旧默认值」。

`GET /admin/runtime` 直接返回**生效值**，没有 `source` 字段。这与 [§5.3](#53-ai-配置) 的 AI 配置不同——那边有「用户自己的配置 vs 部署方环境变量默认」两层来源要区分，这里只有一层，默认值是代码里的常量，环境变量里根本没有这一项。

| 字段 | 下限 | 上限 | 代码默认 |
|---|---|---|---|
| `tagConcurrency` | 1 | 16 | 2 |
| `tagPerUserInflight` | 1 | 4 | 1 |
| `importConcurrency` | 1 | 8 | 2 |
| `ffmpegConcurrency` | 1 | `min(CPU 核数, 16)` | 2 |

越界返回 `VALIDATION_FAILED`，**不是静默截断**——截断的表现是「填了 16、提示保存成功、回显还是 2」，管理员会以为没存上。`ffmpegConcurrency` 的上限取 CPU 核数，因为那是「这台机器同时能跑几个 ffmpeg」唯一有依据的判据。

**交叉约束：`tagPerUserInflight ≤ tagConcurrency`。** 一个人最多能占多少槽，大于总槽数时这一项等于不存在——**静默无效的配置比报错更难查**，所以按越界处理。

⚠️ **这里的每一个数都是「每个服务进程」的，不是全站的。** 多副本时实际全局上限 = 配置值 × 进程数。这与 [queue.md §1](../api/agents/rules/queue.md)「不假设单副本」相邻但不冲突：那张规则管的是**正确性**（不重复消费），这里的并发数管的是**节流**；改成真正的全局上限需要分布式限流，而本项目不引入 Redis（[§9.11](09-decisions.md)）。接口文案与界面措辞都必须按「每个服务进程」说。

生效**不是事务性的「立即」**：打标 worker 在下一轮 tick 读到新值，而那一轮可能正卡在等一个在途任务完成上；导入按批次读一次，已经在跑的批次整批用旧值。见 [§6.5.5](06-endpoints.md)。
