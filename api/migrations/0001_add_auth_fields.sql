-- users テーブルに認証フィールドを追加。name は unique (同名ログイン不可)。
-- password_hash は scrypt ハッシュ値。明文はここに来ない。
ALTER TABLE "users" ADD COLUMN "name" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "users_name_key" ON "users" USING btree ("name");--> statement-breakpoint

-- セッションテーブル。会話は PostgreSQL に保存し Redis は使わない。SPEC §3.1 / §9.11
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");
