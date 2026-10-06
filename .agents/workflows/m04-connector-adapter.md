---
description: Verify Single-Instance Telegram Connector and StorageAdapter implementation (M04)
---
1. Verify StorageAdapter interface completeness: upload, download, delete, refreshReference, exists.
2. Ensure workers/telegram-connector runs as a singleton process preventing concurrent session access.
3. Validate message queuing and serialization of requests sent to the Telegram connector.
4. Run integration tests on adapter methods.
