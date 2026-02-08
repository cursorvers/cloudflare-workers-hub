# Write Approval (Exception Only)

This is required before using any of:

- `freee_api_post`
- `freee_api_put`
- `freee_api_patch`
- `freee_api_delete`

## Preconditions

- [ ] `freee_auth_status` confirmed valid
- [ ] `freee_get_current_company` matches intended company
- [ ] Targets enumerated as stable IDs (no fuzzy selection)
- [ ] "Before" snapshots captured with `freee_api_get` and saved under `30_results/` or `40_changes/`
- [ ] Exact payload(s) drafted (paste below)
- [ ] Rollback plan written (how to restore if wrong)

## Scope

- Goal:
- Why is this a one-off (not a code change):
- Max number of records to touch:

## Target IDs

Paste the exact IDs here.

```text
<id1>
<id2>
```

## Payload Draft

Paste the exact request payload(s) and endpoint(s) here (no placeholders).

```json
{}
```

## Rollback Plan

Describe how you will revert if needed.

