# freee-mcp Path Discovery (Choosing The Right Endpoint)

When you use `freee_api_list_paths`, you typically get a long list of API paths. This doc provides a deterministic way to choose the right endpoint without getting stuck.

Rule: do path discovery in Read-Only mode only.

## Quick Workflow (No Dead Ends)

1. Run `freee_api_list_paths`.
2. Filter down to a short candidate list using keywords (below).
   - Our default starting point is **expenses** (経費). Start with `expense` / `expense_application`.
3. Prefer **GET list endpoints** first.
4. Run one list GET with the smallest time window possible.
5. Save the raw list response as `30_results/candidates.json`.
6. Narrow locally:
   - Not Found: `find-candidates.mjs`
   - Duplicates: `group-duplicates.mjs`
   - Misclassification: pick examples + `analyze-misclassification.mjs`
7. Only after IDs are stable, run detail GETs (`details_<id>.json`).

## What To Look For In Paths

Prefer endpoints that:

- are `GET` (read-only)
- clearly correspond to a collection/list
- accept `company_id` and date range parameters (best for tight-window investigations)

Avoid starting with endpoints that:

- are write methods (POST/PUT/PATCH/DELETE)
- are exports/bulk operations
- return huge payloads without filters

## Keyword Sets (Search In list_paths Output)

Use these as substring searches in the `freee_api_list_paths` output.

### Core Entities

- Deals / transactions: `deal`, `deals`, `transaction`
- Expenses: `expense`, `expenses`, `expense_application`, `expense_applications`
- Partners: `partner`, `partners`
- Receipts (if present): `receipt`, `receipts`
- Invoices (if present): `invoice`, `invoices`

### Misclassification / Master Data

- Account items: `account_item`, `account_items`
- Taxes: `tax`, `tax_code`, `tax_codes`
- Items: `item`, `items`
- Sections / departments: `section`, `sections`
- Tags: `tag`, `tags`

### Metadata That Helps (optional)

- `created`, `updated`
- `status`
- `approval`

## Local Filtering Of Paths (Optional)

If you copy the list_paths output into a file, you can filter it locally.

Recommended evidence files in a session folder:

- `30_results/paths.txt` (plain text, one path per line)
- `30_results/paths.json` (JSON array of strings, if your UI provides JSON)

```bash
node scripts/freee-mcp/filter-paths.mjs <pathsFile> --query deals
```
