-- CreateEnum
CREATE TYPE "DismissReason" AS ENUM ('NOT_A_QUOTE', 'DUPLICATE', 'SPAM', 'OTHER');

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "dismissReason" "DismissReason",
ADD COLUMN     "dismissedAt" TIMESTAMP(3),
ADD COLUMN     "dismissedById" UUID;

-- CreateIndex
CREATE INDEX "Opportunity_organizationId_dismissedAt_idx" ON "Opportunity"("organizationId", "dismissedAt");

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_dismissedById_fkey" FOREIGN KEY ("dismissedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
