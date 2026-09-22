-- 运行参数单行表（SPEC §5.6 / §6.5.5 / §9.26）。
--
-- 把四个**保护机器**的并发上限从模块级常量挪到这里，由 admin 在设置页的管理员分段改，
-- 改完不用重启：打标 worker 下一轮 tick 读到，导入按批次读到。它们原来是
-- `queue/worker.ts` ×2、`services/import.ts` ×1、`image/constants.ts` ×1，
-- 而机器规格因部署而异（2 核和 16 核需要的上限不同），改一次要改代码 + 重新部署。
--
-- ⚠️ 四列**全部可空**，`NULL` = 用代码里的默认值。空表、空行、空列都是正常状态，
--    不是「未初始化」：刚部署的站一次都不配，行为与常量时代逐字相同。等于默认值的输入
--    在保存时归一成 `NULL`（`data/runtime-config.ts`）——显式存一个 `2` 会在默认值
--    将来改成别的数之后把它钉住，而界面上看不出「这是被钉住的旧默认值」。
--
-- ⚠️ 上下限**刻意不写进 DDL**。`ffmpeg_concurrency` 的上限是 `min(CPU 核数, 16)`，
--    核数要运行期才知道（`services/runtime-config.ts` 里 `os.availableParallelism()`），
--    写进 DDL 等于把上限钉死成迁移那一刻那台机器的核数。越界在服务端报
--    `VALIDATION_FAILED`，**不静默截断**。
--
-- 单行模式照 `embed_config`（0000）：`id` 默认 1 + `check (id = 1)`，「全站一份」在
-- 数据层面也成立。**不改已合入的迁移**（project-structure.md §迁移）。
CREATE TABLE "runtime_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tag_concurrency" integer,
	"tag_per_user_inflight" integer,
	"import_concurrency" integer,
	"ffmpeg_concurrency" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "runtime_config_singleton" CHECK ("runtime_config"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "runtime_config" ADD CONSTRAINT "runtime_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
