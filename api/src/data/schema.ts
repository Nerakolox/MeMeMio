import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

/**
 * 表结构主源是 SPEC §5，这个文件是它的 drizzle 表达，不是另一份设计。
 * 改这里之前先改 SPEC；只改这里等于偷偷改契约。
 *
 * 数据库 snake_case、接口 camelCase，转换只发生在序列化层（SPEC §7.1）。
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** AES-GCM 密文列。存 bytea 而不是 text 是 SPEC §5.3 定的，别顺手改成 base64 字符串。 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

// ── §5.1 User 与邀请 ────────────────────────────────────────────────

/** role 取值 'member' | 'admin'。见 SPEC §3.2。 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role').notNull().default('member'),
    /** 登录名，唯一。不在 User 对外表示里，但在 memes.uploaderName 里使用。 */
    name: text('name').notNull(),
    /** bcrypt/scrypt 哈希，明文不落盘。SPEC §3.1。 */
    passwordHash: text('password_hash').notNull(),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  // 同名登录不可。0001 建了这个唯一索引，schema.ts 补上声明（原因同 sessions）
  (table) => [uniqueIndex('users_name_key').on(table.name)],
)

/**
 * 会话存 PostgreSQL，不引入 Redis。见 SPEC §3.1 / §9.11
 *
 * 两个索引不是装饰：`0001_add_auth_fields.sql` 建表时就带上了它们（按 user_id 找会话、
 * 按 expires_at 清过期会话），但 schema.ts 一直没声明，于是每次 `db:generate` 都会
 * 生成一份想把它们删掉的迁移。在这里补齐，schema 与库才对得上。
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
)

export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  usedBy: uuid('used_by').references(() => users.id),
  usedAt: timestamptz('used_at'),
  expiresAt: timestamptz('expires_at'),
})

// ── §5.2 Meme ──────────────────────────────────────────────────────

/**
 * 共享库主表。**检索时不按归属过滤**，uploader_id 只用于写权限判断（SPEC §0.1 / §5.2）。
 * 所有读写只允许经过 data/memes.ts —— 软删过滤和归属检查只有在唯一入口成立时才成立。
 */
export const memes = pgTable(
  'memes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 上传者，不是「拥有者」。命名是刻意的，见 SPEC §7.2。 */
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),

    // 存储与去重
    storageKey: text('storage_key').notNull(),
    /** 用户提供的字符串，和 mime 一样不可信。只参与 trgm，不进 search_text。SPEC §5.2.3 */
    originalFilename: text('original_filename'),
    contentHash: text('content_hash').notNull(),
    phash: bigint('phash', { mode: 'bigint' }).notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    /** 前端复制/下载分流的唯一依据，不能靠 mime 推断。SPEC §5.2.2 */
    isAnimated: boolean('is_animated').notNull(),

    // AI 产出，SPEC §5.2.3
    ocrText: text('ocr_text'),
    description: text('description'),
    emotions: text('emotions').array(),
    scenes: text('scenes').array(),
    tags: text('tags').array(),
    /** 派生字段：ocr_text + description + 三个数组。任一来源变更时必须重算。 */
    searchText: text('search_text'),
    /** 全站固定 1024 维，不是每条记录的属性，所以没有 embed_dim 字段。SPEC §5.2.4 */
    embedding: vector('embedding', { dimensions: 1024 }),

    // 溯源
    visionModel: text('vision_model'),
    embedModel: text('embed_model'),
    /** pending | ok | refused | needs_manual，SPEC §5.2.3 */
    tagStatus: text('tag_status').notNull().default('pending'),
    editedBy: uuid('edited_by').references(() => users.id),
    editedAt: timestamptz('edited_at'),

    /** 非空即已删除。所有常规读路径必须过滤，SPEC §3.4 / §5.2.5。 */
    deletedAt: timestamptz('deleted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // content_hash 是硬约束，不能降级：字节完全相同的文件不可能出现两条记录
    uniqueIndex('memes_content_hash_key').on(table.contentHash),

    // ⚠️ phash 刻意**不是**唯一约束，只建普通索引。加了会硬性挡掉 Hamming 距离为 0 的情况，
    //    而那恰恰可能是用户看过之后决定要保留的不同图 —— 判断权在人，DB 不能先斩后奏。
    //    见 SPEC §5.2.1 / §9.7，以及 agents/rules/database.md §3。
    index('memes_phash_idx').on(table.phash),

    index('memes_created_at_idx').on(table.createdAt.desc()),
    index('memes_uploader_id_idx').on(table.uploaderId),
    index('memes_tag_status_idx').on(table.tagStatus),

    // 三路混合检索（SPEC §9.10）各自要的索引：
    // 1) pg_trgm 子串匹配。original_filename 参与 trgm 但不进 search_text，待遇不同是有意的（SPEC §5.2.3）
    index('memes_search_text_trgm_idx').using('gin', sql`${table.searchText} gin_trgm_ops`),
    index('memes_original_filename_trgm_idx')
      .using('gin', sql`${table.originalFilename} gin_trgm_ops`),
    // 2) 标签过滤
    index('memes_tags_idx').using('gin', table.tags),
    index('memes_emotions_idx').using('gin', table.emotions),
    index('memes_scenes_idx').using('gin', table.scenes),
    // 3) 向量。共享库没有 WHERE uploader_id = ? 这个过滤条件，HNSW 跑在最舒服的状态；
    //    deleted_at is null 选择率接近 1，不构成同类问题。见 agents/rules/database.md §2
    index('memes_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
)

// ── §5.3 AI 配置 ───────────────────────────────────────────────────

/** 视觉配置每人一份。api_key_enc 是 AES-GCM 密文，主密钥在 CONFIG_ENC_KEY。 */
export const userAiConfigs = pgTable('user_ai_configs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),

  visionBaseUrl: text('vision_base_url'),
  visionApiKeyEnc: bytea('vision_api_key_enc'),
  visionModel: text('vision_model'),

  visionFbBaseUrl: text('vision_fb_base_url'),
  visionFbApiKeyEnc: bytea('vision_fb_api_key_enc'),
  visionFbModel: text('vision_fb_model'),

  // 以下三个是「测试连接」的探测结果，**不接受客户端写入**。SPEC §5.3 / §9.7
  visionJsonModeWorks: boolean('vision_json_mode_works'),
  visionMultiImage: boolean('vision_multi_image'),
  verifiedAt: timestamptz('verified_at'),
})

/** Embedding 配置全站一份 —— 共享库的硬约束，不是可调参数。SPEC §5.2.4 / §9.6 */
export const embedConfig = pgTable(
  'embed_config',
  {
    id: integer('id').primaryKey().default(1),
    baseUrl: text('base_url'),
    apiKeyEnc: bytea('api_key_enc'),
    model: text('model'),
    nativeDim: integer('native_dim'),
    dimParamWorks: boolean('dim_param_works'),
    verifiedAt: timestamptz('verified_at'),
  },
  (table) => [check('embed_config_singleton', sql`${table.id} = 1`)],
)

// ── §5.4 收藏 ──────────────────────────────────────────────────────

/**
 * 收藏是**人和图的关系**，不是图的属性。共享库里必须独立成表，
 * 否则 A 收藏了 B 也会看到收藏态。软删不级联删除它，物理删除时才级联。SPEC §5.4
 */
export const userFavorites = pgTable(
  'user_favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    memeId: uuid('meme_id')
      .notNull()
      .references(() => memes.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.memeId] })],
)

// ── 打标队列（SPEC §9.11） ─────────────────────────────────────────

/**
 * 用 PostgreSQL 自己做队列，不引入 Redis。理由见 SPEC §9.11。
 *
 * **它不是 `memes` 的一部分**：有独立的访问方法（`data/tag-jobs.ts`），不走 `data/memes.ts`。
 * 但入队时的 `meme_id` 必须来自 `data/memes.ts` 的查询结果——在队列表上 join `memes`
 * 会绕过 `deleted_at is null`，表现是给已删除的图打标。见 agents/rules/queue.md §8。
 *
 * 消费者（调视觉模型、生成 embedding）是独立任务，本表先建起来供入队。
 */
export const tagJobs = pgTable(
  'tag_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memeId: uuid('meme_id')
      .notNull()
      .references(() => memes.id, { onDelete: 'cascade' }),
    /**
     * 上传者。**冗余列，不是外键便利**——并发要按人分配（queue.md §4），
     * 一个人导入一千张不能把别人的图堵在后面，所以取任务时必须能按人分组。
     *
     * 存一份而不是 join `memes`：在队列表上 join `memes` 会绕过 `deleted_at is null`
     * （queue.md §8），而且 `memes` 的 SQL 只许出现在 `data/memes.ts`
     * （project-structure.md）。入队时的值来自 `createMeme` 的返回行，来源仍然是那一层。
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** pending | running | done | failed，状态机见 agents/rules/queue.md */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * 重试靠推后 run_after，不靠 sleep——worker 里长 sleep 会占着消费槽什么都不干。
     * 见 agents/rules/queue.md §3。
     */
    runAfter: timestamptz('run_after').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // 取任务的那条语句：where status='pending' and run_after <= now() order by run_after。
    // FOR UPDATE SKIP LOCKED 是方案成立的基础，索引要能直接喂它。
    index('tag_jobs_claim_idx').on(table.status, table.runAfter),
    /** 按人轮转取任务时要按 user_id 过滤，claim_idx 喂不了这一路。 */
    index('tag_jobs_user_idx').on(table.status, table.userId),
    /**
     * 一条 meme 同时只应有一个在途任务。
     * 重复入队（比如 commit 被重放）靠 onConflictDoNothing 变成空操作，
     * 否则同一张图会被打标两次，直接浪费用户的钱。
     */
    uniqueIndex('tag_jobs_meme_id_key').on(table.memeId),
  ],
)

// ── §5.5 导入批次 ──────────────────────────────────────────────────

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  total: integer('total').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  /** created_at + 24h。但 needs_review 的条目在用户处理前不清理，见 SPEC §5.5。 */
  expiresAt: timestamptz('expires_at').notNull(),
  /**
   * commit 时刻。**非空即已提交**，服务端处理只能启动一次。
   *
   * commit 要在处理开始前抢一个原子标志：否则客户端重试一次 commit（网络抖动下常见）
   * 就会让同一批文件被处理两遍——第二遍不报错，只是把每个文件又走一遍 ffmpeg、
   * 又判一次重复。有它就退化成一次幂等的空操作。
   */
  committedAt: timestamptz('committed_at'),
})

export const importItems = pgTable(
  'import_items',
  {
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    /** imported | exact_dup | needs_review | failed */
    result: text('result'),
    memeId: uuid('meme_id').references(() => memes.id),
    /** needs_review 时指向库里相似的那张。保留 similar 一词是 SPEC §7.2 的历史例外。 */
    similarTo: uuid('similar_to').references(() => memes.id),
    distance: integer('distance'),
    tempStorageKey: text('temp_storage_key'),
    reason: text('reason'),
    /**
     * 待确认队列要拿它和库里那张并排对比（SPEC §6.2.3），而条目本身还没进 `memes`，
     * 配额在 commit 时就该按声明值扣住，所以要在条目上留一份。
     */
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.fileName] }),
    // 待确认队列是跨批次查 result = 'needs_review'（SPEC §6.2.3），
    // 主键前缀是 batch_id，帮不上这个查询。
    index('import_items_result_idx').on(table.result),
  ],
)
