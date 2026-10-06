---
description: Run Telegram MTProto POC (M03) in accordance with Section D of Master Blueprint
---
Read AGENTS.md and .agents/rules/telegram-mtproto.md before execution.

Steps:
1. Initialize MTProto client with User Account credentials (GramJS).
2. Connect and provision user storage peer.
3. Test small file upload -> extract message ID and document metadata.
4. Test file download streaming -> verify file integrity and checksum.
5. Simulate disconnect -> execute exponential backoff reconnect.
6. Test reference expiration -> trigger reference refresh recovery flow.
7. Record results and complete verification report.
