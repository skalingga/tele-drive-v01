# API Conventions

## 1. Response Envelope
All API endpoints must return a unified JSON envelope:
```json
// Success Response:
{
  "data": { ... },
  "error": null,
  "meta": {
    "next_cursor": "eyJpZCI6MTIzfQ==",
    "total": 42
  }
}

// Error Response:
{
  "data": null,
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not own this file",
    "details": null
  },
  "meta": {}
}
```

## 2. Cursor-Based Pagination (Mandatory)
- List and search endpoints MUST use opaque base64 cursor pagination (encoding record ID and creation timestamp).
- Offset pagination is prohibited on file listings to prevent performance degradation and duplicate/missing entries during real-time writes.
- Parameters: `cursor` (string, optional), `limit` (number, default 50, maximum 200).
- `meta.next_cursor` must be populated when more items exist, or `null` when the end is reached.

## 3. Standard Error Codes
- `AUTH_REQUIRED`: Missing or expired session token.
- `FORBIDDEN`: Resource belongs to another user or peer mismatch.
- `NOT_FOUND`: Resource does not exist or has been permanently purged.
- `VALIDATION_ERROR`: Zod schema failure on payload or query parameters.
- `UPLOAD_FAILED`: Transfer error or network breakdown during storage pipe.
- `STORAGE_REFERENCE_EXPIRED`: Telegram file reference expired and couldn't be refreshed.
- `STORAGE_RATE_LIMITED`: Telegram FLOOD_WAIT encountered.
- `CONFLICT`: File name collision or concurrent write conflict.
- `INTERNAL_ERROR`: Unhandled exception.
