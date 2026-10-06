# Testing Standards (Learned Context)

- All repositories must be tested against an active database client (or in-memory mock).
- Security tests must simulate multi-user tenant boundaries.
- StorageAdapter must guarantee stream backpressure and memory bounding.
