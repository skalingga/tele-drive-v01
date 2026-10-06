# API Conventions (Learned Context)

- Envelope standard: `{ data, error, meta }`.
- Pagination: Base64 opaque cursor containing `{ id, createdAt }`.
- HTTP Status Codes:
  - 200 OK: Successful query / command
  - 400 Bad Request: Validation error
  - 401 Unauthorized: Session missing
  - 403 Forbidden: Ownership violation (IDOR prevented)
  - 404 Not Found: Entity missing or purged
  - 409 Conflict: Filename collision or duplicate key
