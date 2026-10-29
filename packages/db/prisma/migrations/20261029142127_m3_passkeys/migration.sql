-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_passkeys" (
    "credential_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_passkeys_pkey" PRIMARY KEY ("credential_id")
);

-- CreateTable
CREATE TABLE "wallet_credentials" (
    "credential_id" TEXT NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "wallet_credentials_pkey" PRIMARY KEY ("credential_id")
);

-- CreateTable
CREATE TABLE "registration_challenges" (
    "user_id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_challenges_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "credential_id" TEXT,
    "assertion_json" JSONB,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registry_passkeys_user_id_idx" ON "registry_passkeys"("user_id");

-- CreateIndex
CREATE INDEX "approvals_user_id_idx" ON "approvals"("user_id");

-- AddForeignKey
ALTER TABLE "registry_passkeys" ADD CONSTRAINT "registry_passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_credentials" ADD CONSTRAINT "wallet_credentials_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "registry_passkeys"("credential_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_challenges" ADD CONSTRAINT "registration_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
