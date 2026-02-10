-- Migration 0028: Add indexes for receipt status API queries.
-- Supports GET /api/receipts?status= and GET /api/receipts/summary.

-- Speed up filtering by freee_deal_id (imported vs pending/unprocessed).
CREATE INDEX IF NOT EXISTS idx_receipts_freee_deal ON receipts(freee_deal_id);

-- Speed up LEFT JOIN + status lookup on receipt_deals.
CREATE INDEX IF NOT EXISTS idx_receipt_deals_receipt_status ON receipt_deals(receipt_id, status);
