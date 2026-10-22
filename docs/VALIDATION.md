# Local 0.4.4 validation

Snapshot: 2026-10-22. Local Windows stdio plugin; cloud candidate results are excluded.

Current-version bounded release acceptance is recorded; all snapshot-listed source and test hashes match this staged source. Runtime delivery is checked separately before copying.

| Check | Result |
| --- | --- |
| Full controlled synthetic suite | 428/428 passed, 27 test files, no skips |
| Native approval | 6/6 native checks passed with naturally visible windows |
| Browser settings | 10 checks, 88 HTTP exchanges for fallback; embedded flow uses zero HTTP requests |
| Native attachment picker | 2 checks: selection and cancellation |
| Installation/runtime | Original Node, official isolated Codex install, 29 tools, settings resource and 60-second idle check |
| OS boundaries | Zero-network AppContainer, directory and process checks |

Embedded browser checks use an opaque-origin iframe without form or modal
permissions. They exercise recovery after initial connection failure, typing,
button save, Enter save, credential clearing and encrypted MCP forwarding through
the real MCP server to the same settings callbacks. Authorization codes do not
appear in the recorded synthetic host messages. Account stores, mail transports
and approval decisions in browser checks are synthetic; native approval is tested
separately. Additional tests cover tampering, replay, expiry, wrong keys,
unapproved changes, changed account revisions, malformed operations and shutdown.

Daily Codex visual embedding and real credential entry for 0.4.4 remain pending
the owner's restart and interaction. The preceding real mailbox check was rejected
by the provider. No real mailbox connection, send or mutation was attempted in
this UI maintenance. Do not treat these synthetic results as real-mail acceptance.
Public CI for the new commit must be checked separately; prior CI is not evidence
for a new commit. This document is updated after publication when CI is available.

The runtime bytes match current local acceptance. Public LICENSE and
THIRD_PARTY_NOTICES remain additional files in the public checksum index.
Ordinary installation is not automatically AppContainer-isolated. Cross-user
validation remains excluded by the owner. Legacy storage migration is not
implemented; no account data was moved or deleted. Earlier host crash causality
remains unconfirmed. Private account data and raw OS traces are not published.
