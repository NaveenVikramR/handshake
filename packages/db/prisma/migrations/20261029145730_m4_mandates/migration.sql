-- CreateTable
CREATE TABLE "mandates" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pending_until" TIMESTAMP(3) NOT NULL,
    "credential_id" TEXT,
    "assertion_json" JSONB,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mandate_spend" (
    "mandate_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "spent_minor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "mandate_spend_pkey" PRIMARY KEY ("mandate_id","period_start")
);

-- CreateIndex
CREATE UNIQUE INDEX "mandates_hash_key" ON "mandates"("hash");

-- CreateIndex
CREATE INDEX "mandates_user_id_idx" ON "mandates"("user_id");

-- AddForeignKey
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mandate_spend" ADD CONSTRAINT "mandate_spend_mandate_id_fkey" FOREIGN KEY ("mandate_id") REFERENCES "mandates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
