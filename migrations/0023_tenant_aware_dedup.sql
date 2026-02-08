-- Migration 0023: Tenant-aware deduplication
--
-- Problem: file_hash UNIQUE constraint is global (not tenant-scoped).
-- Different tenants uploading the same file get blocked, and attackers
-- can probe file existence via 409 responses.
--
-- Solution: Add a tenant-scoped unique index. The original UNIQUE on
-- file_hash cannot be dropped in SQLite, but adding a composite index
-- ensures the application-layer query (WHERE tenant_id=? AND file_hash=?)
-- is efficient. The old global UNIQUE acts as an extra safety net for
-- the current single-tenant deployment.
--
-- When multi-tenant is fully enabled, recreate the table without the
-- global UNIQUE on file_hash (requires data migration).

-- Composite unique index for tenant-scoped dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_tenant_file_hash
  ON receipts(tenant_id, file_hash);

-- Optimize the dedup lookup query
CREATE INDEX IF NOT EXISTS idx_receipts_dedup_lookup
  ON receipts(tenant_id, file_hash, id);
