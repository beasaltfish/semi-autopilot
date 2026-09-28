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
ALTER TABLE "channels" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_decisions" ADD CONSTRAINT "reply_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reply_decisions_pending" ON "reply_decisions" USING btree ("feedback","expired_at","created_at");