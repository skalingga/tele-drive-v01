# MTProto Patterns (Learned Context)

## Session Management
- GramJS `StringSession` provides portable encrypted session storage.
- Concurrent MTProto sessions against the same user account from multiple processes result in `401 AUTH_KEY_UNREGISTERED` or packet desynchronization.
- Pattern: Run a single dedicated connector process (`workers/telegram-connector`) to manage MTProto session.

## File References
- Telegram `file_reference` expires periodically.
- StorageAdapter refreshReference queries Telegram message history using `peer_id` + `message_id` to acquire fresh `file_reference` before streaming.
