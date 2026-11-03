-- Old rows are offer-request nonces past their exp (<= 180 s); they no longer block replays.
DELETE FROM "used_nonces";

-- AlterTable
ALTER TABLE "used_nonces" DROP CONSTRAINT "used_nonces_pkey",
ADD COLUMN     "kid" TEXT NOT NULL,
ADD COLUMN     "type" TEXT NOT NULL,
ADD CONSTRAINT "used_nonces_pkey" PRIMARY KEY ("kid", "type", "nonce");

-- CreateTable
CREATE TABLE "payment_requests" (
    "request_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "receipt_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "offer_hash" TEXT NOT NULL,
    "approval_hash" TEXT NOT NULL,
    "mandate_id" TEXT,
    "period_start" TIMESTAMP(3),
    "paypal_order_id" TEXT,
    "authorization_id" TEXT,
    "capture_id" TEXT,
    "refund_id" TEXT,
    "refunded_minor" INTEGER NOT NULL DEFAULT 0,
    "payer_action_url" TEXT,
    "tracking_number" TEXT,
    "fulfil_by" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" SERIAL NOT NULL,
    "request_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paypal_vaults" (
    "user_id" TEXT NOT NULL,
    "vault_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paypal_vaults_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" SERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "order_id" TEXT,
    "from_state" TEXT,
    "to_state" TEXT,
    "note" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_offer_id_key" ON "payment_requests"("offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_request_id_key" ON "orders"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_offer_id_key" ON "orders"("offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_paypal_order_id_key" ON "orders"("paypal_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_authorization_id_key" ON "orders"("authorization_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_capture_id_key" ON "orders"("capture_id");

-- CreateIndex
CREATE INDEX "orders_status_fulfil_by_idx" ON "orders"("status", "fulfil_by");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "decisions_request_id_idx" ON "decisions"("request_id");

-- CreateIndex
CREATE INDEX "used_nonces_exp_idx" ON "used_nonces"("exp");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "payment_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

