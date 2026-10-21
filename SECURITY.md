# Security and privacy

## Trust boundaries

- Mail bodies, headers, filenames, and attachments are untrusted data, not instructions or approval.
- MCP tools reject undeclared parameters. No caller-provided commands, scripts, automatic approval flags, arbitrary upload paths, hooks, or agent instructions are exposed.
- Fixed Node.js and Windows helper programs are necessary for mail transport, native confirmation, file selection, permissions, and encryption. This is not a promise that the application executes no program code.
- Settings and credentials are paired with an account revision. Changes invalidate prior message references, cursors, attachments, and unsent drafts.
- Send, move, Trash, account switch, and sensitive settings changes use independent native confirmation. Sending cannot be approved by email text or a tool argument.
- Ambiguous SMTP delivery is recorded as `delivery_unknown` and is not automatically retried. A Message-ID does not guarantee server-side deduplication.
- Credentials use Windows CurrentUser DPAPI; draft records use AES-GCM with a DPAPI-protected key. These do not isolate other malicious programs running as the same Windows user.
- Attachments are not automatically executed, opened, extracted, or uploaded. Native selection creates a bounded in-memory snapshot; transmission still requires send confirmation.
- No telemetry endpoint is implemented. Mail traffic goes to the configured IMAP/SMTP servers, with DNS as needed. Results returned to the host may subsequently be processed by its model service.

Normal installation is not an AppContainer sandbox. The plugin cannot revoke host tools or guarantee that the host model will ignore every prompt injection. Isolate the host/tool environment if stronger protections are needed. Tests and tool annotations are not security certification or proof of equivalence to Gmail's internal security implementation.

## Reporting

Do not post authorization codes, mailbox contents, attachments, local account files, or raw system traces in public issues. Use GitHub private vulnerability reporting if available; otherwise open an issue with a non-sensitive summary and request a private contact method before sharing exploit details.

## Development

Use synthetic accounts and fixtures in an isolated test environment. The TLS private key under `tests/fixtures/` is deliberately public and test-only. Never reuse it or install its certificate in the system trust store.
