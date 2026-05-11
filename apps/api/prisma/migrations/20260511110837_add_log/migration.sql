-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG');

-- CreateTable
CREATE TABLE "Log" (
    "id" UUID NOT NULL,
    "level" "LogLevel" NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "context" TEXT,
    "stack" TEXT,
    "metadata" JSONB,
    "requestId" TEXT,
    "userId" UUID,
    "organizationId" UUID,

    CONSTRAINT "Log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Log_level_createdAt_idx" ON "Log"("level", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Log_organizationId_createdAt_idx" ON "Log"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Log_requestId_idx" ON "Log"("requestId");
