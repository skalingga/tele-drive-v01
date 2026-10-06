---
description: Run Cross-User and Cross-Peer Security Audit Gate (M13)
---
1. Create Test User A and Test User B.
2. Upload file under User A.
3. Attempt read, download, rename, trash, restore, or delete of User A's file using User B's session.
4. Verify HTTP 403 / FORBIDDEN response and strict peer-level isolation.
5. Verify no sensitive tokens or passwords leaked in API payloads or logs.
