-- CreateTable
CREATE TABLE "registry_merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "paypal_merchant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "registry_merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_agents" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "merchant_id" TEXT,

    CONSTRAINT "registry_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "stock" INTEGER NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("sku")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "hold_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_holds" (
    "offer_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "stock_holds_pkey" PRIMARY KEY ("offer_id","sku")
);

-- CreateTable
CREATE TABLE "used_nonces" (
    "nonce" TEXT NOT NULL,
    "exp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "used_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "registry_merchants_paypal_merchant_id_key" ON "registry_merchants"("paypal_merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_hash_key" ON "offers"("hash");

-- CreateIndex
CREATE INDEX "offers_agent_id_status_idx" ON "offers"("agent_id", "status");

-- CreateIndex
CREATE INDEX "offers_status_hold_until_idx" ON "offers"("status", "hold_until");

-- AddForeignKey
ALTER TABLE "registry_agents" ADD CONSTRAINT "registry_agents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "registry_merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "registry_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_sku_fkey" FOREIGN KEY ("sku") REFERENCES "products"("sku") ON DELETE RESTRICT ON UPDATE CASCADE;
