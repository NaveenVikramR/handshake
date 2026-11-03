-- AlterTable
ALTER TABLE "paypal_vaults" ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "payer_email" TEXT,
ADD COLUMN     "payer_id" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending';
