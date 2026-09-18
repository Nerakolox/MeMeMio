-- 两张新表，都是「模型配置与测试连接」任务需要的（SPEC §6.5）：
--
-- config_tests   测试连接的结果存服务端。探测结果字段不接受客户端写入（§5.3），
--                所以 PUT 里不能靠前端回传「我测过了」，必须落库再查。
--                只存 key 的 SHA-256 指纹，**不存明文也不存密文**（§6.5.2）。
--
-- reindex_jobs   重建索引队列。不复用 tag_jobs：那张表 meme_id 上有唯一索引，
--                一条重算任务会和同一张图的待打标任务互相踢掉；而且重算不调视觉模型。
--
-- user_ai_configs 和 embed_config 在 0000 里已经建好，本次不动它们的结构。

CREATE TABLE "config_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"user_id" uuid,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"ok" boolean NOT NULL,
	"json_mode_works" boolean,
	"multi_image" boolean,
	"native_dim" integer,
	"dim_param_works" boolean,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reindex_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meme_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_tests" ADD CONSTRAINT "config_tests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reindex_jobs" ADD CONSTRAINT "reindex_jobs_meme_id_memes_id_fk" FOREIGN KEY ("meme_id") REFERENCES "public"."memes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_tests_lookup_idx" ON "config_tests" USING btree ("scope","key_fingerprint");--> statement-breakpoint
CREATE INDEX "reindex_jobs_claim_idx" ON "reindex_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "reindex_jobs_meme_id_key" ON "reindex_jobs" USING btree ("meme_id");