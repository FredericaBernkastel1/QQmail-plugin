# Local 0.4.3 validation

Snapshot: 2026-10-22. Local Windows stdio plugin; cloud candidate results are excluded.

Current-version bounded release acceptance is recorded; all snapshot-listed source and test hashes match this staged source. `tsconfig.json`, `vitest.config.ts` were not included in those snapshots and are admitted only because their bytes exactly match the reviewed public 0.3.0 baseline. They are not claimed as snapshot-covered inputs. Runtime delivery is checked separately before copying.

| Check | Result |
| --- | --- |
| Full controlled synthetic suite | 414/414 passed, 26 test files, no skips |
| Native approval | 6/6 native checks passed with naturally visible windows |
| Browser settings | 8 checks, 94 HTTP exchanges, no unexpected egress or page errors |
| Native attachment picker | 2 checks: selection and cancellation |
| Installation/runtime | Original Node, official isolated Codex installation, 26 tools, settings resource and 60-second idle check |
| OS boundaries | Zero-network AppContainer, directory and process checks |

The maintenance source commit 1459ffb595a11118c28c205a545150d60ecde7cc passed both [push CI](https://github.com/FredericaBernkastel1/QQmail-plugin/actions/runs/39720778171) and [PR CI](https://github.com/FredericaBernkastel1/QQmail-plugin/actions/runs/39720783049). The earlier attachment-save failure occurred near the old 10-second native drive-query deadline. Cold-start timeout is the leading explanation; the old sanitized log did not preserve a native stack. The deadline is now 30 seconds; deterministic late-success/timeout tests and real native path tests both pass. No path protection or assertion was removed. Check the latest commit's CI separately.

Nineteen new account regressions cover pending interactive flags/move/Trash during connection or selection, credential replacement, A-to-B-to-A changes and partial flags. Five drive-query regressions cover bounded cold starts, timeout, late results, network paths and invalid output.

Real mailbox validation is partial and distinct: a prior version completed limited read-only access, but the latest resumed authentication was rejected. Current-version real sending, attachment round-trip, mailbox mutation and daily task-grant acceptance are not complete. No real email was sent or modified during this maintenance. No personal account data or raw system evidence is included in this repository.

The promoted runtime bytes match current local acceptance. Public LICENSE and THIRD_PARTY_NOTICES remain additional files covered by the public checksum index. Normal installation is not automatically AppContainer-isolated. Cross-user validation remains excluded by the owner. External-browser configuration improvements are deferred. Existing legacy accounts remain in place; automatic storage migration is not implemented. Host crash causality remains unconfirmed.
