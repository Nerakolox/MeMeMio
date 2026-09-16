-- tag_jobs 增加 user_id：并发按人分配（agents/rules/queue.md §4）需要在队列表上按人分组，
-- 而运行时不许在 tag_jobs 上 join memes（§8：会绕过 deleted_at is null）。
--
-- drizzle-kit 生成的是单条 `ADD COLUMN NOT NULL`，在已有 pending 任务的库上会直接失败。
-- 拆成三步：先可空、回填、再加约束。

ALTER TABLE "tag_jobs" ADD COLUMN "user_id" uuid;--> statement-breakpoint

-- 回填。**这是允许在 memes 上写 SQL 的唯一场景**——迁移不是数据访问层，
-- 而且这里要的是 uploader_id 这个事实本身，和软删过滤无关：
-- 已软删的图，它的任务照样回填，worker 取到后 findMemeById 返回 null，任务直接判完成。
UPDATE "tag_jobs" j SET "user_id" = m."uploader_id" FROM "memes" m WHERE m."id" = j."meme_id";--> statement-breakpoint

ALTER TABLE "tag_jobs" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_jobs" ADD CONSTRAINT "tag_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_jobs_user_idx" ON "tag_jobs" USING btree ("status","user_id");
