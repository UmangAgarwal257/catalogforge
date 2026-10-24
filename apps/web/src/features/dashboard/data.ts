import { getDb } from "@catalogforge/db";
import { visibleProducts } from "@catalogforge/review/catalog";

export async function dashboardData(storeId: string) {
  const db = getDb();
  const open = { storeId, status: { in: ["DRAFT", "NEEDS_REVIEW"] as ("DRAFT" | "NEEDS_REVIEW")[] }, product: { archivedAt: null } };
  const failed = { storeId, OR: [{ status: "FAILED" as const }, { catalogTask: { is: { state: "FAILED" } } }] };
  const [totalProducts, needingReview, approved, published, activeImports, failedImports, quotaPaused, imports, actions, failures] = await db.$transaction([
    db.product.count({ where: { storeId, archivedAt: null } }),
    db.productRevision.count({ where: open }),
    db.productRevision.count({ where: { storeId, status: "APPROVED", product: { archivedAt: null } } }),
    db.product.count({ where: visibleProducts(storeId) }),
    db.import.count({ where: { storeId, OR: [{ status: { in: ["PENDING", "PROCESSING", "PAUSED"] } }, { catalogTask: { is: { state: { in: ["PENDING", "RUNNING", "WAITING"] } } } }] } }),
    db.import.count({ where: failed }),
    db.catalogTask.count({ where: { storeId, state: "WAITING", errorCode: "FREE_TIER_QUOTA" } }),
    db.import.findMany({ where: { storeId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5,
      select: { id: true, originalFilename: true, status: true, totalRows: true, createdAt: true, errorMessage: true, supplier: { select: { name: true } }, catalogTask: { select: { state: true, phase: true, errorCode: true, nextAttemptAt: true } } } }),
    db.productRevision.findMany({ where: open, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 6,
      select: { id: true, productId: true, title: true, status: true, editVersion: true, createdAt: true, product: { select: { supplier: { select: { name: true } } } } } }),
    db.import.findMany({ where: failed, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 6,
      select: { id: true, originalFilename: true, status: true, errorMessage: true, catalogTask: { select: { errorCode: true, errorMessage: true } } } }),
  ], { isolationLevel: "RepeatableRead" });
  return { kpis: { totalProducts, needingReview, approved, published, activeImports, failedImports, quotaPaused }, imports, actions, failures };
}
