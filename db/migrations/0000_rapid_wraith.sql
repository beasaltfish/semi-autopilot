CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(20) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"channel_name" varchar(255),
	"space_id" varchar(255),
	"space_name" varchar(255),
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "channels_source_channel_id_unique" UNIQUE("source","channel_id")
);
--> statement-breakpoint
CREATE TABLE "generation_attempts" (
	"external_id" varchar(255) PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(20) NOT NULL,
	"message_id" varchar(255) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"space_id" varchar(255) NOT NULL,
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"timestamp" timestamp NOT NULL,
	"reply_to_message_id" varchar(255),
	"thread_id" varchar(255),
	"is_filtered" boolean DEFAULT false,
	"raw_data" jsonb,
	"embedding" vector(1024),
	"processed" boolean DEFAULT false,
	"is_question" boolean,
	"question_confidence" integer,
	"question_type" varchar(50),
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "messages_source_message_id_unique" UNIQUE("source","message_id")
);
--> statement-breakpoint
CREATE TABLE "reply_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"stage" varchar(20) NOT NULL,
	"route" varchar(20) NOT NULL,
	"jev" jsonb,
	"retrieved_ids" integer[],
	"mention_author_id" varchar(255),
	"draft" text,
	"telegram_message_id" integer,
	"feedback" varchar(10),
	"edited_text" text,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"feedback_at" timestamp with time zone,
	CONSTRAINT "reply_decisions_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(20) NOT NULL,
	"thread_id" varchar(255) NOT NULL,
	"original_message_id" varchar(255) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "threads_source_thread_id_unique" UNIQUE("source","thread_id")
);
--> statement-breakpoint
CREATE TABLE "tweets" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"dedupe_key" varchar(255) NOT NULL,
	"source" varchar(50),
	"source_ref" varchar(255),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"media_path" text,
	"archetype" varchar(20),
	"tier" varchar(10),
	"entities" text[],
	CONSTRAINT "tweets_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "reply_decisions" ADD CONSTRAINT "reply_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_messages_channel_id" ON "messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_messages_timestamp" ON "messages" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_processed" ON "messages" USING btree ("processed","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_is_question" ON "messages" USING btree ("is_question");--> statement-breakpoint
CREATE INDEX "idx_messages_author_id" ON "messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_messages_thread_id" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_messages_reply_to" ON "messages" USING btree ("reply_to_message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_timestamp" ON "messages" USING btree ("channel_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_context_search" ON "messages" USING btree ("channel_id","is_question","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_space_id" ON "messages" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "idx_messages_content_fts" ON "messages" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "idx_reply_decisions_pending" ON "reply_decisions" USING btree ("feedback","expired_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_tweets_claim" ON "tweets" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_tweets_posted_at" ON "tweets" USING btree ("posted_at");