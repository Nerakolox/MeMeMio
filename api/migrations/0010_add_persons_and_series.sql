-- 人物与系列（SPEC §5.7），是「人物识别与聚类」任务的第一批：
--
-- persons          人物。图数、封面、成员一律过 memes.deleted_at is null（§5.7.4），
--                  图全被软删的人物**行保留**、只是不出现在列表里——图被恢复时
--                  人物跟着回来，与收藏不级联是同一个道理。
-- series           系列 = 人物的父级，只由人挑选组成。名字唯一性按 lower(btrim(name))。
-- meme_subjects    一张图一行：整图一个向量，至多归一个人物。
--                  embed_model 存「模型 + 预处理口径」（如 Qwen/…@768）——改长边
--                  等于换模型，比较只在同一口径的向量之间做（§5.7.1）。
-- person_rejections 人点过的「不是同一个」，合并建议不再给这一对。
--                  较小的 id 放前面（应用层保证），否则 (A,B) 与 (B,A) 会各存一条。
-- image_embed_config 图片向量配置，全站单行，与 embed_config 同构 + image_input_works。
-- person_vector_jobs 算人物向量的队列。独立于 tag_jobs（人物不能挡打标）也独立于
--                  reindex_jobs（那个装的是文本向量，口径与重试语义都不同）。
--
-- 外键里有两处是**故意**的：`persons.series_id` / `persons.cover_meme_id` 用
-- `on delete set null`（删系列不删人物、物理删图不留下悬空封面）；而
-- `meme_subjects.person_id` **不加 cascade**——人物行只在「一张图都不剩」时被删，
-- 那一刻不该还有行指着它，真有的话要的是当场报错而不是安静抹掉归属。

CREATE TABLE "image_embed_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"base_url" text,
	"api_key_enc" "bytea",
	"model" text,
	"native_dim" integer,
	"dim_param_works" boolean,
	"image_input_works" boolean,
	"verified_at" timestamp with time zone,
	CONSTRAINT "image_embed_config_singleton" CHECK ("image_embed_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "meme_subjects" (
	"meme_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(1024),
	"embed_model" text,
	"person_id" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_rejections" (
	"person_id" uuid NOT NULL,
	"other_person_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_rejections_person_id_other_person_id_pk" PRIMARY KEY("person_id","other_person_id")
);
--> statement-breakpoint
CREATE TABLE "person_vector_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meme_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"series_id" uuid,
	"cover_meme_id" uuid,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "config_tests" ADD COLUMN "image_input_works" boolean;--> statement-breakpoint
ALTER TABLE "meme_subjects" ADD CONSTRAINT "meme_subjects_meme_id_memes_id_fk" FOREIGN KEY ("meme_id") REFERENCES "public"."memes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meme_subjects" ADD CONSTRAINT "meme_subjects_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meme_subjects" ADD CONSTRAINT "meme_subjects_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_rejections" ADD CONSTRAINT "person_rejections_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_rejections" ADD CONSTRAINT "person_rejections_other_person_id_persons_id_fk" FOREIGN KEY ("other_person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_rejections" ADD CONSTRAINT "person_rejections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_vector_jobs" ADD CONSTRAINT "person_vector_jobs_meme_id_memes_id_fk" FOREIGN KEY ("meme_id") REFERENCES "public"."memes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_cover_meme_id_memes_id_fk" FOREIGN KEY ("cover_meme_id") REFERENCES "public"."memes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meme_subjects_person_id_idx" ON "meme_subjects" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "meme_subjects_embedding_hnsw_idx" ON "meme_subjects" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "person_rejections_other_idx" ON "person_rejections" USING btree ("other_person_id");--> statement-breakpoint
CREATE INDEX "person_vector_jobs_claim_idx" ON "person_vector_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "person_vector_jobs_meme_id_key" ON "person_vector_jobs" USING btree ("meme_id");--> statement-breakpoint
CREATE INDEX "persons_series_id_idx" ON "persons" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "persons_name_trgm_idx" ON "persons" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "series_name_key" ON "series" USING btree (lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "series_name_trgm_idx" ON "series" USING gin ("name" gin_trgm_ops);