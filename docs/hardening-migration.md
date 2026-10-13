# Fork hardening and migration (draft)

This fork derives from [marmottajr/habblaud](https://github.com/marmottajr/habblaud),
upstream `4ccce2537472fe5a8d432f06974494d2e778ff15` (0.11.0).
Original copyright 2026 Márcio Junior and MIT LICENSE are unchanged. These changes
are proposed hardening, not an upstream release or a production security certification.

## Artifact authorization — breaking change

Transcripts describe artifacts but cannot authorize filesystem access. File attachments
now require an operator-maintained JSON policy selected by `HABBLAUD_DELIVERY_SCOPES`.
The policy is reloaded on every read, and again before returning the bytes. It is an
array of exact account/session/project grants. There are no wildcards or global list
of known projects, no automatic grant creation, and no HTTP route to edit the policy.

Synthetic example only (replace with explicitly approved identifiers and canonical paths):

```json
[
  {
    "account": "synthetic-account",
    "sessionId": "synthetic-session-a",
    "project": "/srv/synthetic-project-a",
    "root": "/srv/synthetic-project-a"
  }
]
```

`root` must equal `project`; both must be absolute canonical paths, never `/`.
Duplicate account/session grants and overlapping distinct project roots invalidate
all grants. Sessions in the same project may have separate explicit grants. The server
binds the stored artifact ID to its observed account/session/project and requires an
exact policy match; the browser cannot supply a substitute scope with the file request.
This is project isolation for authorized artifacts, **not** browser-user tenancy.

The policy must be outside every granted project, a regular single-link file, at most
1 MiB, and not group/world writable (use restrictive ownership/ACLs, typically mode 0600).
The agent must not be able to change the policy, its parent directory, or server config.
A chmod check does not establish separation from another process using the same OS user.
No permissions are changed automatically. Protect the policy with an existing isolated
operator/service boundary before granting access; otherwise leave delivery files disabled.

Missing, malformed, ambiguous or unverifiable grants fail closed. A file outside the
session project is refused even if another project is also authorized. Symlink aliases
(including parent directories), hardlinked files, traversal and special files are refused.
A renamed/missing project requires a fresh explicit grant. To deliver a file from an
external or temporary location, copy an approved regular file into the granted project;
do not broaden the root to a parent containing other projects.

Node and container deployments use the same verifier. Containers need the approved
canonical paths and policy present in their own namespace using operator-reviewed
read-only mounts. **No fallback to the legacy host bridge or account-path remapping**
is allowed for production deliveries. Existing bridge-only attachments will fail closed
until their storage can be verified; do not restore them by globally allowing `/tmp`.
Inline captures already contained in transcripts continue to follow existing terminal
access controls. Other bridge operations are outside this artifact change.

The read uses async bounded descriptor I/O, O_NOFOLLOW/O_NONBLOCK, descriptor/path
identity checks, and post-read mutation checks. It is limited to four concurrent reads
and 25 MiB per artifact (plus one byte to detect growth). Bytes are not cached; HTTP
responses use `Cache-Control: no-store`. Previously downloaded/browser-cached copies
cannot be recalled. Filesystem checks are not a sandbox against privileged concurrent
namespace/mount manipulation; use OS isolation and stable read-only exports for that
threat model. Platforms without the required filesystem semantics fail closed and need
separate compatibility validation. Windows/macOS have not been validated here.

## Remote sessions

Authenticated responses are registered with their session. Revocation closes active
responses immediately in-process. Expiry is checked with one shared, unref'ed 1-second
timer while responses exist; close/finish removes registrations and clears the idle timer.
A revoked/expired token cannot reconnect, while a new valid token can. Long authenticated
responses other than SSE also close when their session becomes invalid.

The sweep costs O(active responses) per second; there is no new connection quota.
An overloaded event loop can delay expiry. Already sent bytes remain at the client.
Credential/config rotation requires restart; this is not cross-process revocation.
The pre-existing same-millisecond token collision remains a separate issue. No claim
of multi-tenant authentication, human approval identity or validated high-scale operation.

## Isolated demo — breaking change

Start with `HABBLAUD_DEMO=1` (also `npm run demo`). The server binds loopback and creates
a fresh temporary state/home directory, ignores real account/state locations, disables
Claude/Codex sources, terminal, messages, spawning, PTY, dictation, remote listener,
update checks and timeline persistence. No legacy state migration runs. Temporary demo
state may remain until OS cleanup; it contains only synthetic/local demo preferences.

The settings overlay and `/api/demo` toggle are disabled: switching demo on in a process
already observing real accounts cannot provide isolation. Stop that process and launch
the isolated demo instead. This changes the previous mixed-real-and-synthetic behavior.
The demo is not an OS sandbox; source/dependencies must still be trusted and tested in
an isolated environment.

## Validation and residual scope

Tests use two synthetic projects, exact grants, stale/deleted files, scope revocation,
file/directory/root symlinks, hardlinks, invalid policy, remote expiry/revocation and
reconnection, plus isolated startup demo with synthetic account settings.

Run `npm run typecheck`, `npm test -- --maxWorkers=2`, and `npm run build` in an isolated
container without accounts/network. Dependency acquisition must precede offline tests;
use `npm ci --ignore-scripts --no-audit --no-fund` only after inspecting the lockfile/scripts.
Existing native PTY skips are not validation of PTY or real Claude/Codex. CI execution and
cross-platform behavior must be checked separately before merge.

Relevant API references: [Node filesystem](https://nodejs.org/api/fs.html) and
[HTTP response lifecycle](https://nodejs.org/api/http.html).

Verified locally on Node 24.21.0 / Linux in the pinned offline container: typecheck
and build passed; 117 test files passed, 1,342 tests passed and 7 were skipped.
The baseline had 1,325 passes and 7 skips. This is not a load benchmark. The CI proposal
uses the same pinned container, no persisted checkout credentials, and dependency
acquisition without lifecycle scripts. It does not expand repository permissions.
