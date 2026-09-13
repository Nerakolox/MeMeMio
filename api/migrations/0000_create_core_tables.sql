-- pgvector 与 pg_trgm 必须先于建表存在：memes.embedding 是 vector(1024)，
-- gin_trgm_ops 也来自 pg_trgm。放在第一条迁移里而不是 compose 的 initdb 脚本里，
-- 是因为 initdb 只在卷第一次创建时跑一次，换环境就会漏。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "embed_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"base_url" text,
	"api_key_enc" "bytea",
	"model" text,
	"native_dim" integer,
	"dim_param_works" boolean,
	"verified_at" timestamp with time zone,
	CONSTRAINT "embed_config_singleton" CHECK ("embed_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_items" (
	"batch_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"result" text,
	"meme_id" uuid,
	"similar_to" uuid,
	"distance" integer,
	"temp_storage_key" text,
	"reason" text,
	CONSTRAINT "import_items_batch_id_file_name_pk" PRIMARY KEY("batch_id","file_name")
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"created_by" uuid NOT NULL,
	"used_by" uuid,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text,
	"content_hash" text NOT NULL,
	"phash" bigint NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"size_bytes" bigint NOT NULL,
	"is_animated" boolean NOT NULL,
	"ocr_text" text,
	"description" text,
	"emotions" text[],
	"scenes" text[],
	"tags" text[],
	"search_text" text,
	"embedding" vector(1024),
	"vision_model" text,
	"embed_model" text,
	"tag_status" text DEFAULT 'pending' NOT NULL,
	"edited_by" uuid,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_ai_configs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"vision_base_url" text,
	"vision_api_key_enc" "bytea",
	"vision_model" text,
	"vision_fb_base_url" text,
	"vision_fb_api_key_enc" "bytea",
	"vision_fb_model" text,
	"vision_json_mode_works" boolean,
	"vision_multi_image" boolean,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_favorites" (
	"user_id" uuid NOT NULL,
	"meme_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorites_user_id_meme_id_pk" PRIMARY KEY("user_id","meme_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"storage_quota_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_meme_id_memes_id_fk" FOREIGN KEY ("meme_id") REFERENCES "public"."memes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_similar_to_memes_id_fk" FOREIGN KEY ("similar_to") REFERENCES "public"."memes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memes" ADD CONSTRAINT "memes_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memes" ADD CONSTRAINT "memes_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_configs" ADD CONSTRAINT "user_ai_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_meme_id_memes_id_fk" FOREIGN KEY ("meme_id") REFERENCES "public"."memes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memes_content_hash_key" ON "memes" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "memes_phash_idx" ON "memes" USING btree ("phash");--> statement-breakpoint
CREATE INDEX "memes_created_at_idx" ON "memes" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memes_uploader_id_idx" ON "memes" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "memes_tag_status_idx" ON "memes" USING btree ("tag_status");--> statement-breakpoint
CREATE INDEX "memes_search_text_trgm_idx" ON "memes" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "memes_original_filename_trgm_idx" ON "memes" USING gin ("original_filename" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "memes_tags_idx" ON "memes" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "memes_emotions_idx" ON "memes" USING gin ("emotions");--> statement-breakpoint
CREATE INDEX "memes_scenes_idx" ON "memes" USING gin ("scenes");--> statement-breakpoint
CREATE INDEX "memes_embedding_hnsw_idx" ON "memes" USING hnsw ("embedding" vector_cosine_ops);