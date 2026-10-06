---
description: Verify Storage Worker and BullMQ job queue orchestration (M05)
---
1. Verify BullMQ worker processing for upload_jobs and download_jobs.
2. Confirm periodic progress updates written to database.
3. Test retry with exponential backoff on transient network faults.
4. Verify graceful worker shutdown and resume capabilities.
