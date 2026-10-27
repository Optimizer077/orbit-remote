# Identity expiry and explicit recovery

Each computer creates its own certificate and private key. A certificate lasts
two years. Local status reports `identity: { expiresAt, daysRemaining, warning,
expired }`; the warning begins thirty days before expiry. There is no scheduled
or silent key replacement. Do not copy a profile or identity to another computer.

After expiry, Orbit keeps its authenticated local administration interface
available, disables remote listening and invitations, and refuses private-key
export to the desktop controller. Restarting the app does not extend expiry.

To recover, the local owner must explicitly confirm that **every device must
pair again**. The desktop action uses the local bearer-protected endpoint
`POST /api/identity/rotate` with
`{ "confirmRePair": true, "expectedFingerprint": "<current fingerprint>" }`.
The exact current fingerprint prevents a stale confirmation from replacing a
different identity. This is a local administration action; remote viewers have
no rotation route. In the desktop app, the owner frame alone can invoke it.
The main process independently opens a native confirmation showing the current
paired-device count, with Cancel as its default. A stale fingerprint or changed
pairing count stops the action before outgoing sessions are disconnected.

Rotation ends active sessions, releases held input, revokes all incoming
pairings and invalidates outstanding invitations. It writes a new protected
identity atomically and requests a graceful host restart. Its `202` response is
`{ state: "restarting", pairingsRevoked: N, requiresRePair: true }`. The audit
records the operation and revoked count without keys or certificate fingerprints.
If persistence fails, access may already be revoked; review local status and
retry deliberately. It never restores old pairing trust automatically.

Pairing state and the staged identity are each written to private temporary
files with an explicit file-content flush before replacement. The revoked
pairing-state write completes before the new identity replaces the old one.
This ordering is not an atomic transaction across both files. Orbit does not
explicitly sync parent-directory metadata, and the operating system, filesystem
and storage hardware still determine what survives abrupt power loss. A normal
reload test proves application ordering and persisted contents, not a physical
power-loss guarantee. After an interrupted recovery, review local identity and
pairing status and pair again deliberately; do not restore old trust files.

Create fresh invitations afterward and pair in both directions as needed.
Saved outgoing connections still pin the remote computers, but those computers
must authorize this computer's new client certificate through fresh pairing.
No remote certificate pin is silently changed.

The desktop supervisor permits six automatic restarts in a ten-minute window,
with delays of 1, 2, 4, 8, 16 and 30 seconds. A healthy response does not reset
that budget; five continuous healthy minutes or an explicit local Retry does.
After exhaustion it stops automatic recovery and offers Retry. Child output is
bounded to a 1 MiB `host.log` and one 1 MiB backup.
Confirmed network-change restarts consume that same budget. Retry does nothing
while the host is healthy, offline or still starting.

Network probes use the desktop's locally resolved Tailscale CLI. Two consecutive
successful observations of a changed or absent verified Tailscale IPv4 request
a clean restart and rebind. A probe failure, timeout or malformed response is
unknown and never triggers a restart by itself. `Running` without a usable IPv4
stays offline. These recovery mechanisms do not enable pre-login or lock-screen
access or change operating-system policy.
