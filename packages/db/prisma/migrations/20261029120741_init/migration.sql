-- CreateTable
CREATE TABLE "paypal_events" (
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paypal_events_pkey" PRIMARY KEY ("event_id")
);
