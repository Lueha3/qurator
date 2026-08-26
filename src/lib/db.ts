import { PrismaClient } from "@prisma/client";

// Next.js 개발 모드의 핫 리로드마다 새 PrismaClient가 생기는 것을 막는 표준 패턴.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
