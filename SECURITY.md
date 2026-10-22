# Security and privacy

## Trust boundaries

- Mail bodies, headers, filenames and attachments are untrusted data. They cannot approve an action or change the plugin's permissions.
- MCP schemas reject undeclared parameters. The plugin exposes no arbitrary command, code execution, host-configuration editing or arbitrary file-upload interface. Its fixed Node.js and Windows helpers perform mail transport, confirmation, file selection, encryption and filesystem protection.
- Account configuration and credentials are captured together. References, cursors, drafts, attachments and task grants are bound to account revisions; switching A to B and back to A does not reactivate an old grant.
- The default interactive profile preserves per-operation Windows confirmation for sending, moving and Trash when no task grant is supplied. Settings and account switching retain their independent native approval.
- A task grant is issued only after independent Windows user approval. It binds the account, actions, exact recipients or message references, operation count and expiry. Send checks every To/Cc/Bcc recipient. Trash and flags check every exact message reference. Purpose text is descriptive and does not enforce message content restrictions.
- A valid task grant permits agent-selected message content within its targets. It is not approval of each message body. The user should operate the native approval window themselves; an agent's assertion, an `approved` field or text in received mail cannot substitute for approval.
- Grants live only in process memory and do not survive restart. Consumption is atomic; downstream failures do not refund operations. Active receipts are rechecked before external dispatch, including after MIME compilation. Revocation cannot recall an operation already dispatched or delivered.
- Draft sending uses a single-attempt state transition and a durable pre-dispatch journal. Ambiguous SMTP delivery becomes `delivery_unknown` and is never automatically retried. A missing Sent copy does not prove non-delivery, and Message-ID is not a server-side deduplication guarantee.
- Credentials use Windows CurrentUser DPAPI. Draft records use AES-GCM with a DPAPI-protected key. These do not isolate malicious software running as the same Windows user.
- Attachments require native selection and become bounded account-scoped memory snapshots. The transport uses byte buffers, disables file and URL access, and does not automatically open, execute, extract or forward incoming attachments. Restart invalidates pending attachment drafts.
- No telemetry endpoint is implemented. Mail traffic goes to configured IMAP/SMTP endpoints, with DNS as needed. Results returned to the MCP host may subsequently be sent to its model service.

## Known limits

Normal installation does not run inside an AppContainer sandbox. The plugin cannot revoke the host's other tools or guarantee that its model ignores every prompt injection. A native window is not a security boundary against malicious UI automation running as the same Windows user.

Attachment paths must use their canonical local spelling. Windows 8.3 short-name aliases may be rejected; select the file using its normal full path. The plugin does not relax its path and handle checks to accept these aliases.

Interactive and grant-backed IMAP writes now recheck the active account revision immediately before each flag or move dispatch, including after connection and mailbox-selection waits. Credential replacement and A-to-B-to-A switches invalidate pending writes. Already dispatched operations cannot be recalled; partial flag/move outcomes remain explicit. In-flight reads retain their paired original account snapshot. SMTP retains its existing final dispatch checks.

Task permissions are finite, not semantic policies. They do not restrict content to what a purpose sentence describes. A read-only profile has six read tools and no grant management; the authorized profile requires a grant for its exposed writes. In the default interactive profile, omitting a grant uses the original interactive rules.

Tests, annotations and source review are bounded evidence, not security certification or evidence of equivalence to Gmail's internal security implementation. See [validation status](docs/VALIDATION.md) for the distinction between synthetic tests, native UI checks and real-mailbox validation.

## Reporting and development

Do not post authorization codes, mailbox contents, attachments, account files or raw system traces in public issues. Use GitHub private vulnerability reporting if available; otherwise post a non-sensitive summary and request a private contact method before sharing exploit details.

Use synthetic accounts and fixtures in an isolated test environment. The TLS key under `tests/fixtures/` is deliberately public and test-only; never reuse it or trust its certificate system-wide. Public source publication excludes personal logs, raw OS evidence, private configuration, caches and test-environment state.
