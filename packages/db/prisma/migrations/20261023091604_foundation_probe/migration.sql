-- CreateTable
CREATE TABLE "FoundationProbe" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoundationProbe_pkey" PRIMARY KEY ("id")
);
