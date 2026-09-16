CREATE TABLE "tag_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meme_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tag_jobs" ADD CONSTRAINT "tag_jobs_meme_id_memes_id_fk" FOREIGN KEY ("meme_id") REFERENCES "public"."memes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_jobs_claim_idx" ON "tag_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_jobs_meme_id_key" ON "tag_jobs" USING btree ("meme_id");