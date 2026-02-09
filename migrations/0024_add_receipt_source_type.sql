-- Migration 0024: Add source_type to receipts table
-- Tracks how the receipt was ingested: PDF attachment or HTML email body.
-- Default 'pdf_attachment' preserves existing records.

ALTER TABLE receipts ADD COLUMN source_type TEXT NOT NULL DEFAULT 'pdf_attachment'
  CHECK(source_type IN ('pdf_attachment', 'html_body'));
