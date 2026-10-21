# Local 0.4.2 validation status

Snapshot date: **2026-10-21**. This document describes the local Windows stdio candidate derived from public main's 0.3.0 baseline. Cloud-branch results do not validate this candidate.

Current-version bounded release acceptance is recorded; all snapshot-listed source and test hashes match this staged source. `tsconfig.json`, `vitest.config.ts` were not included in those snapshots and are admitted only because their bytes exactly match the reviewed public 0.3.0 baseline. They are not claimed as snapshot-covered inputs. Runtime delivery is checked separately before copying.

| Check | Recorded status | Scope |
| --- | --- | --- |
| Controlled synthetic suite | **390/390 passed** | Count is extracted only from matching current-version acceptance, not copied from historical results |
| Native task-authorization window | **6/6 native checks passed with naturally visible windows** | Includes the user-visible Forms requirement; pure presentation-builder unit tests do not validate a real window |
| Full native/UI/OS/install acceptance | **Bounded synthetic release acceptance recorded; real mailbox remains untested** | Requires current-version evidence and the release gate |
| Public Windows CI | **Prepared; not run by this document** | Typecheck, all local test files including the 26/17/6 profile assertions, and build |
| Real mailbox / real sending | **Not performed** | No real QQ account, credential or user message was used for this snapshot |
| Everyday Codex desktop behavior | **Not claimed verified** | Synthetic MCP tests do not establish daily interactive desktop behavior |

The previously fixed Windows approval visibility behavior is retained: the Forms window is explicitly displayed while the PowerShell console remains hidden. All six current native checks passed with naturally visible windows. The final synthetic count above is extracted from the matching 0.4.2 acceptance record after reruns, not inherited from an earlier result. These controlled native checks do not establish end-to-end sending through a real mailbox or everyday Codex desktop behavior.

The suite covers immutable bounded grants, pending confirmation capacity, concurrent operation budgets, account binding, invalid IDs without fallback, exact To/Cc/Bcc and message-reference restrictions, revocation/expiry, attachment and draft workflows, and the final SMTP authorization boundary. The draft journal preserves unknown delivery outcomes across restart; grants deliberately do not persist.

CI runs on a disposable Windows runner because native file helpers use Windows PowerShell. It does not use cloud tests or claim Linux can validate Windows native behavior. It preserves the existing build/test scripts, public synthetic TLS fixtures and separate Playwright convention. UI and live mailbox checks are not silently inferred from CI success.

Hosted Windows uses a regular workspace-local temporary directory for synthetic files and a finite 30-second test timeout for native helper cold starts. Its initial run exposed the runner's short-path TEMP alias and two 5-second framework timeouts. Product canonical-path checks and native operation deadlines are unchanged; no assertions or test files were skipped.

The source branch and `QQmailplugin/` runtime are promoted separately. Runtime copying requires matching 0.4.2 acceptance, delivery and checksum records. Runtime payload files and author metadata are copied byte-for-byte. Public `LICENSE` and `THIRD_PARTY_NOTICES.md` are retained as publication additions; the public runtime checksum index covers these extra files as well. Original private acceptance records and raw test outputs are not published.

Known operating limits, including the original-account behavior of already-started interactive IMAP operations without a task grant, are documented in [SECURITY.md](../SECURITY.md).

The 0.4.2 storage fix adds 13 regression cases for first and repeated account saves, legacy state retention, conflicting stores, access denial, a real redirected directory, and EXDEV failures preserving original bytes and cleaning only the new temporary file. Windows native canonical-path resolution is checked because synchronous link metadata did not identify the tested junction reliably. The actual user directory was tested only with synthetic files. The installed live-account setup still requires the user to save and approve their credentials; live mailbox success is not inferred. Private paths, probe records and user data are excluded from this repository.
