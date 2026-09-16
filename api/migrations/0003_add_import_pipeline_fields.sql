ALTER TABLE "import_batches" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_items" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
CREATE INDEX "import_items_result_idx" ON "import_items" USING btree ("result");