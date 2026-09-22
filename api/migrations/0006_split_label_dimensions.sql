-- 语义维度拆分（SPEC §4.3、§4.3.1、§9.22，词表 v0.2.0）。
--
-- 原来只有 emotions / scenes / tags 三个数组，于是「一张微笑角色配『你说得都对』的图」
-- 无处可放：脸是微笑、心里是什么图上没说、语气是敷衍或阴阳怪气、交流用途是表面附和。
-- 三个数组只能把它压成「开心、赞同」——两个都是错的，而且错得没有任何地方会报错。
--
-- 拆成六个维度：
--   expressions  面部表情（看得见的事实）      ← 新列
--   emotions     情绪（内心状态）              ← 原列，收窄
--   tones        表达语气（怎么说）            ← 新列
--   purposes     聊天用途（想完成什么交流动作）  ← 新列
--   scenes       生活情境（上班、考试、没钱）    ← 原列，收窄到只剩现实场合
--   tags         主体与风格                    ← 原列，不动
--
-- 按 SPEC §4.4 的「移动词条到别的维度」处理：**DDL 迁移（建新列）+ 数据迁移（搬值）**，
-- 两步都在这个文件里。只建列不搬值的表现是旧图的表情和语气凭空消失，而 tag_status
-- 仍然是 ok——没有任何地方会提示这些图需要重打标。

DROP INDEX "memes_search_text_trgm_idx";--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "expressions" text[];--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "tones" text[];--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "purposes" text[];--> statement-breakpoint

-- 搬值。旧的 emotions ∪ scenes 里每个词按 v0.2.0 的归属重新落位，顺带做一次别名
-- 归一化（同意→赞同、吃瓜→围观、凡尔赛→自夸、赶due→赶进度……）。
--
-- ⚠️ 三个旧词条**没有对应的新词条，本次直接丢弃**：被催、回复长篇大论、等待。
--    它们说的是消息形态或一个持续状态，既不是「交流动作」也不是「生活情境」；
--    硬塞进 purposes 会把那一维的语义搅浑。丢弃是有意的，写在这里免得以后当 bug 查。
--    这是 SPEC §4.4「删除词条 → 迁移到替代词条**或清除**」的第二种处置。
--
-- ⚠️ `WHERE emotions IS NOT NULL OR scenes IS NOT NULL` 是为了**不碰从没打过标的图**。
--    少了这个条件，它们的六个数组会从 NULL 变成 '{}'，看上去像「标过了，只是什么都没标出来」。
--
-- 三个新列没有 NOT NULL / DEFAULT，和原有的 emotions / scenes / tags 保持一致：
-- NULL 表示「没标过」，'{}' 表示「标过、这一维为空」，两者在打标状态里含义不同。
WITH moves(term, dim, canonical) AS (VALUES
    ('开心'::text, 'emotions'::text, '开心'::text),
    ('大笑', 'expressions', '大笑'),
    ('得意', 'emotions', '得意'),
    ('兴奋', 'emotions', '兴奋'),
    ('满足', 'emotions', '满足'),
    ('无语', 'emotions', '无语'),
    ('无奈', 'emotions', '无奈'),
    ('嫌弃', 'emotions', '嫌弃'),
    ('鄙视', 'emotions', '鄙视'),
    ('翻白眼', 'expressions', '翻白眼'),
    ('生气', 'emotions', '生气'),
    ('暴躁', 'emotions', '暴躁'),
    ('崩溃', 'emotions', '崩溃'),
    ('抓狂', 'emotions', '抓狂'),
    ('委屈', 'emotions', '委屈'),
    ('难过', 'emotions', '难过'),
    ('哭泣', 'expressions', '哭泣'),
    ('绝望', 'emotions', '绝望'),
    ('震惊', 'emotions', '震惊'),
    ('疑惑', 'emotions', '疑惑'),
    ('迷茫', 'emotions', '迷茫'),
    ('呆滞', 'expressions', '呆滞'),
    ('尴尬', 'emotions', '尴尬'),
    ('心虚', 'emotions', '心虚'),
    ('害羞', 'emotions', '害羞'),
    ('社死', 'emotions', '社死'),
    ('冷漠', 'emotions', '冷漠'),
    ('面无表情', 'expressions', '面无表情'),
    ('假笑', 'expressions', '假笑'),
    ('阴阳怪气', 'tones', '阴阳怪气'),
    ('摆烂', 'emotions', '摆烂'),
    ('疲惫', 'emotions', '疲惫'),
    ('困倦', 'emotions', '困倦'),
    ('生无可恋', 'emotions', '生无可恋'),
    ('撒娇', 'tones', '撒娇'),
    ('卖萌', 'tones', '卖萌'),
    ('期待', 'emotions', '期待'),
    ('讨好', 'tones', '讨好'),
    ('得逞', 'emotions', '得逞'),
    ('坏笑', 'expressions', '坏笑'),
    ('挑衅', 'tones', '挑衅'),
    ('看戏', 'purposes', '围观'),
    ('打招呼', 'purposes', '打招呼'),
    ('告别', 'purposes', '告别'),
    ('早安晚安', 'purposes', '早安晚安'),
    ('同意', 'purposes', '赞同'),
    ('拒绝', 'purposes', '拒绝'),
    ('敷衍', 'tones', '敷衍'),
    ('已读不回', 'purposes', '结束话题'),
    ('催促', 'purposes', '催促'),
    ('求饶', 'purposes', '求饶'),
    ('道歉', 'purposes', '道歉'),
    ('夸奖', 'purposes', '夸奖'),
    ('捧场', 'purposes', '起哄'),
    ('自夸', 'purposes', '自夸'),
    ('凡尔赛', 'purposes', '自夸'),
    ('吐槽', 'purposes', '吐槽'),
    ('抬杠', 'purposes', '反驳'),
    ('反驳', 'purposes', '反驳'),
    ('嘲讽', 'purposes', '嘲讽'),
    ('认输', 'purposes', '认输'),
    ('甩锅', 'purposes', '甩锅'),
    ('装死', 'purposes', '结束话题'),
    ('表示没听懂', 'purposes', '表示不解'),
    ('表示不想听', 'purposes', '拒绝'),
    ('被冒犯', 'purposes', '表达不满'),
    ('劝退', 'purposes', '拒绝'),
    ('让对方闭嘴', 'purposes', '警告'),
    ('加班', 'scenes', '加班'),
    ('下班', 'scenes', '下班'),
    ('上班摸鱼', 'scenes', '上班摸鱼'),
    ('周一', 'scenes', '周一'),
    ('放假', 'scenes', '放假'),
    ('吃饭', 'scenes', '吃饭'),
    ('点外卖', 'scenes', '点外卖'),
    ('喝酒', 'scenes', '喝酒'),
    ('睡觉', 'scenes', '睡觉'),
    ('打游戏', 'scenes', '打游戏'),
    ('被虐', 'scenes', '被虐'),
    ('求带', 'purposes', '求助'),
    ('花钱', 'scenes', '花钱'),
    ('没钱', 'scenes', '没钱'),
    ('发工资', 'scenes', '发工资'),
    ('求红包', 'purposes', '求助'),
    ('追星', 'scenes', '追星'),
    ('磕到了', 'scenes', '追星'),
    ('被塞狗粮', 'scenes', '被塞狗粮'),
    ('考试', 'scenes', '考试'),
    ('交作业', 'scenes', '交作业'),
    ('赶due', 'scenes', '赶进度'),
    ('围观', 'purposes', '围观'),
    ('吃瓜', 'purposes', '围观'),
    ('看热闹', 'purposes', '围观')
)
UPDATE "memes" m SET
  "expressions" = (
    SELECT coalesce(array_agg(DISTINCT mv.canonical), '{}')
    FROM unnest(coalesce(m."emotions", '{}') || coalesce(m."scenes", '{}')) AS t(term)
    JOIN moves mv ON mv.term = t.term
    WHERE mv.dim = 'expressions'
  ),
  "emotions" = (
    SELECT coalesce(array_agg(DISTINCT mv.canonical), '{}')
    FROM unnest(coalesce(m."emotions", '{}') || coalesce(m."scenes", '{}')) AS t(term)
    JOIN moves mv ON mv.term = t.term
    WHERE mv.dim = 'emotions'
  ),
  "tones" = (
    SELECT coalesce(array_agg(DISTINCT mv.canonical), '{}')
    FROM unnest(coalesce(m."emotions", '{}') || coalesce(m."scenes", '{}')) AS t(term)
    JOIN moves mv ON mv.term = t.term
    WHERE mv.dim = 'tones'
  ),
  "purposes" = (
    SELECT coalesce(array_agg(DISTINCT mv.canonical), '{}')
    FROM unnest(coalesce(m."emotions", '{}') || coalesce(m."scenes", '{}')) AS t(term)
    JOIN moves mv ON mv.term = t.term
    WHERE mv.dim = 'purposes'
  ),
  "scenes" = (
    SELECT coalesce(array_agg(DISTINCT mv.canonical), '{}')
    FROM unnest(coalesce(m."emotions", '{}') || coalesce(m."scenes", '{}')) AS t(term)
    JOIN moves mv ON mv.term = t.term
    WHERE mv.dim = 'scenes'
  )
WHERE m."emotions" IS NOT NULL OR m."scenes" IS NOT NULL;--> statement-breakpoint

-- `tags` 这一维本身不动，但里面有一个词条要改名：`3D` → `三维`。
-- SPEC §4.3.2 的「中文，不混英文」对正式词条没有例外（双通道的词汇对齐靠它），
-- 而 `3D` 从 v0.1.0 起就在违反。`3D` / `3d` 登记成别名，用户照样搜得到。
-- 不改的话它会在 `api/src/vocab.test.ts` 的「中文，不混英文」那条上红着。
UPDATE "memes" SET "tags" = array_replace("tags", '3D', '三维')
WHERE "tags" @> ARRAY['3D']::text[];--> statement-breakpoint

-- search_text 是派生列（SPEC §5.2.3），六个数组一动它就旧了。按
-- `lib/vision-output.ts` 的 buildSearchText 重算：ocrText、description，然后六个数组按
-- expressions → emotions → tones → purposes → scenes → tags 拼接，空串剔掉，空格连接。
-- **顺序必须和那个函数一致**，否则同一张图下次重打标时 search_text 会整个变样。
--
-- 不顺手重算 embedding：迁移里不发网络请求。本次搬值几乎不改变 search_text 的词集合
-- （同一批词换了个位置），漂移很小；真要对齐走 `POST /admin/reindex`。
UPDATE "memes" SET "search_text" = array_to_string(
  array_remove(array_remove(
    ARRAY[btrim(coalesce("ocr_text", '')), btrim(coalesce("description", ''))]
    || coalesce("expressions", '{}') || coalesce("emotions", '{}')
    || coalesce("tones", '{}') || coalesce("purposes", '{}')
    || coalesce("scenes", '{}') || coalesce("tags", '{}'),
  NULL), ''),
  ' '
)
WHERE "search_text" IS NOT NULL;--> statement-breakpoint

-- 文本通路改成只匹配 ocr_text + description，不再匹配 search_text（SPEC §9.21）。
-- search_text 里拼着六个数组的标签值，让 trgm 也匹配它们等于同一个信号被文本路和标签路
-- 各计一次分——靠标签沾边的图会压过原文精确命中的图，而排序被带偏不会报错。
-- 旧索引因此删掉（上面第一句）：现在没有查询会用它，留着只是每次写入白付一遍维护代价。
--
-- ⚠️ 新索引的表达式**必须和 `data/search.ts` 的 textTarget() 逐字一致**。
--    差一个空格索引就用不上，而查询照样能跑出正确结果——只是慢，不报错。
--
-- 四个索引都建在数据搬完之后：先灌数据再建索引比边建边灌快，也不会留下一身膨胀。
CREATE INDEX "memes_text_trgm_idx" ON "memes" USING gin ((coalesce("ocr_text", '') || ' ' || coalesce("description", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "memes_expressions_idx" ON "memes" USING gin ("expressions");--> statement-breakpoint
CREATE INDEX "memes_tones_idx" ON "memes" USING gin ("tones");--> statement-breakpoint
CREATE INDEX "memes_purposes_idx" ON "memes" USING gin ("purposes");
