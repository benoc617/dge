import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const connectionString = process.env.DATABASE_URL!;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  mariadbAdapter: PrismaMariaDb | undefined;
};

/**
 * Single shared adapter (and its internal connection pool) reused across hot-reloads in dev.
 * PrismaMariaDb manages the mariadb connection pool internally.
 */
function getAdapter(): PrismaMariaDb {
  if (!globalForPrisma.mariadbAdapter) {
    const url = new URL(connectionString);
    globalForPrisma.mariadbAdapter = new PrismaMariaDb({
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      connectionLimit: 20,
    });
  }
  return globalForPrisma.mariadbAdapter;
}

function createClient() {
  return new PrismaClient({
    adapter: getAdapter(),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
