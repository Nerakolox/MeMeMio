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
  emotions      text[],
  scenes        text[],
  tags          text[],
  search_text   text,                 -- 上述字段拼接
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

单次视觉调用产出全部五个字段，不做独立 OCR 链路。三个数组字段的取值必须落在 [§4](04-vocabulary.md) 的词表内。

`search_text` 是 `ocr_text` + `description` + 三个数组拼接的结果，供 embedding 与 `pg_trgm` 子串匹配使用。它是派生字段，任何一个来源字段变更时必须重算。

> ⚠️ **`original_filename` 参与 `pg_trgm` 匹配，但不进 `search_text`，因此不进 embedding。**
>
> 存下来的理由：从网上保存的表情包，文件名里常常带着梗名，那是梗名最便宜的来源之一（见 [§9.18](09-decisions.md)）。不进 embedding 的理由：大量文件名是 `IMG_1234.jpg`、`微信图片_20240101.jpg` 这类纯噪声，混进向量只会稀释语义。**两条路径待遇不同是有意的。**

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

`embed_model` 保留，用于管理员更换模型后找出待重算的记录。全站统一 embedding 的理由见 [§9.6](09-decisions.md)——这是共享库带来的硬约束，不是可调参数。

### §5.2.5 软删

`deleted_at` 非空即已删除。所有常规读路径必须过滤，见 [§3.4](03-auth-permission.md)。

R2 上的原图延迟清理：软删满 30 天后由定时任务物理删除，此时才从配额中释放。

### §5.2.6 对外表示

```
{
  id, uploaderId, uploaderName,
  url, thumbUrl,            // 由 storageKey 派生的访问地址，不返回 storageKey 本身
  mime, width, height, sizeBytes, isAnimated, originalFilename,
  ocrText, description, emotions[], scenes[], tags[],
  tagStatus, visionModel,
  favorited,                // 当前登录用户是否收藏，见 §5.4
  editedBy?, editedAt?, createdAt
}
```

**不返回**：`contentHash`、`phash`、`embedding`、`searchText`、`embedModel`、`deletedAt`、`storageKey`。它们是内部字段，客户端没有消费场景。

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
