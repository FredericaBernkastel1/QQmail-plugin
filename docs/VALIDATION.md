# 0.3.0 validation scope

The local release was accepted on 2026-10-21 using synthetic mail and a restricted Windows AppContainer, a private desktop, and bounded process jobs. The acceptance records and raw OS metadata remain local and are not included in this public repository.

| Area | Recorded result |
| --- | --- |
| Business tests | 246/246 passed across 18 files |
| Settings UI | 8 checks, 94 HTTP interactions; desktop/mobile |
| Native approval | 4 checks |
| Native attachment picker | 2 checks |
| Native file handle / DPAPI / ACL | Passed recorded cases |
| Isolation boundary | Passed recorded checks |
| Independent Codex installation and original Node stdio | Passed |

The full suite used a documented, test-only Node pipe adaptation required by the isolated harness. Independent installed stdio verification used unmodified Node. No adapted Node binary is distributed here.

The public copy preserves the tested server bundle, source map, linked legal comments, settings UI, and production TypeScript source. Publication changes are repository/author metadata, documentation, license notices, and regenerated checksums. These do not constitute a new complete test run of the public checkout.

Not verified: a real user's QQ mailbox, ordinary Codex desktop embedding, all possible mail servers, cross-Windows-user isolation, or a hard Node RSS cap. A successful synthetic 100 MiB streaming download does not prove every real server implements partial FETCH correctly. Ordinary installation does not inherit the test sandbox.
