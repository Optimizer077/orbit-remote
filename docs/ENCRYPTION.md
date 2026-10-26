# How Orbit protects your connection

**In short:** everything Orbit sends between your computers is encrypted twice:
once by Tailscale and once by Orbit itself. Each side proves who it is with a
certificate that was pinned when you paired. Orbit refuses any connection that
lacks forward secrecy or authenticated encryption. You can check the
protection yourself: the viewer shows the encryption it actually negotiated,
and each computer has a security code you can compare.

This page explains what that means, what you can check, and what it does
**not** protect against.

## Two layers of encryption

| Layer | What it does | Who provides it |
|---|---|---|
| **Tailscale (WireGuard)** | Only devices in your tailnet can reach the host port at all. Traffic between them is encrypted with WireGuard, including through Tailscale's relays. | Tailscale |
| **Orbit mutual TLS** | Inside that tunnel, Orbit opens its own encrypted connection. Both computers present certificates, and each checks the other's against the one it pinned when you paired. | Orbit |
| **Orbit permissions** | After identity is proven, the host checks what this device may do: view, control, clipboard, files, power. | Orbit |

Orbit's TLS layer runs from the Orbit process on one computer to the Orbit
process on the other. Tailscale's coordination servers and relays only ever see
WireGuard ciphertext, and inside it Orbit's own TLS ciphertext. No Orbit server
is involved.

## What you can check in the app

### The encryption line in the viewer

While you view a computer, the status bar under the screen reads, for example:

> 🔒 Encrypted end to end · TLS 1.3 · AES-256-GCM · X25519

These values are **measured on the actual connection** for the most recent
screen update. They are not a fixed label. If a connection ever fell below
Orbit's policy, it would be blocked and the screen would stop updating, rather
than showing a weaker value.

### The security code

Every Orbit installation has its own identity certificate. Its **security code**
is the first 128 bits of the certificate's SHA-256 fingerprint, shown as eight
groups of four characters:

```text
551F 68EA 65A3 120A 7850 178C 5ACC 72C0
```

- On each computer, **Overview → This computer → Security code** shows that
  computer's own code.
- On the other computer, **Devices → ⋯ (Manage) → Security code** shows the code
  it pinned for that device.

**The two must match exactly.** A match means the computer you paired with is
the one you think it is, so nobody intercepted the invitation and put
themselves in the middle. If they differ, don't connect: revoke or forget the
device and pair again over a channel you trust. Compare codes once after
pairing, for example by reading them aloud on a call or looking at both
screens.

You need to compare only once per pairing. Afterwards Orbit itself blocks any
change: if a device later presents a different certificate, the connection is
refused with "Device identity changed".

## Orbit's encryption policy (technical)

| Property | Policy | Where it is enforced |
|---|---|---|
| Protocol | TLS 1.3 preferred. TLS 1.2 allowed only with the suites below. | Client offer + host check |
| TLS 1.3 suites | `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`, `TLS_AES_128_GCM_SHA256` | Both |
| TLS 1.2 suites | ECDHE only, AEAD only: `ECDHE-{RSA,ECDSA}-AES256-GCM-SHA384`, `-CHACHA20-POLY1305`, `-AES128-GCM-SHA256` | Both |
| Refused | CBC suites, static-RSA key exchange (no forward secrecy), DHE, TLS ≤ 1.1, unknown suites | Both |
| Server identity | Exact SHA-256 pin of the host certificate, checked before any HTTP byte is sent (including the pairing secret) | Viewer (`transport.cjs`) |
| Client identity | Client certificate required. Its SHA-256 fingerprint must match a current, unrevoked pairing. | Host (`Program.cs`) |
| Identity keys | RSA-3072, self-signed, two-year validity, generated on each computer, never copied | Host (`Security.cs`) |
| Key storage | Windows: current-user DPAPI. macOS/Linux: user-only file permissions (native secret stores planned). | Host |

**Two independent checks.** The viewer offers only allowed suites and re-checks
the negotiated suite after every handshake (`describeLink` in
`apps/desktop/electron/transport.cjs`). The host checks the negotiated protocol
and suite in Kestrel connection middleware, after the handshake and before any
HTTP parsing, and drops the connection if it falls short (`Security.IsStrongTls`
in `src/Orbit.Host/Security.cs`). Neither side relies on the other being
configured correctly.

**Why TLS 1.2 is still allowed.** Both ends are Orbit, so TLS 1.3-only would be
simpler. But .NET's TLS on macOS may not serve TLS 1.3. Requiring it would
break Mac hosts before they can be validated. The TLS 1.2 suites that remain
have the same core guarantees: ephemeral key exchange and authenticated
encryption. TLS 1.3's downgrade protection prevents an attacker from forcing
TLS 1.2 when both sides support 1.3.

## Measured results

Measured on 2026-10-26 on Windows x64 against the real Orbit host (.NET 10,
Schannel) in loopback test mode. Clients: Node.js 24 (OpenSSL 3.5) and
Electron 45 (BoringSSL).

| Client offer | Before this policy | Now |
|---|---|---|
| Orbit default | TLS 1.3 · AES-256-GCM · X25519 | Served: TLS 1.3 · AES-256-GCM · X25519 |
| TLS 1.2 only, Orbit suites | ECDHE-RSA-AES256-GCM · P-384 | Served |
| TLS 1.2, CBC only | **Served** (ECDHE-RSA-AES256-SHA) | **Refused** |
| TLS 1.2, static RSA only | **Served** (AES256-GCM-SHA384, no forward secrecy) | **Refused** |

Automated coverage: `npm test` (transport tests for weak servers, link
description, and that no pairing secret reaches a weak server), the host
harness (`IsStrongTls` allowlist), and the Electron end-to-end test, which
asserts that a real session reports TLS 1.3 with forward secrecy and that both
security codes match. See [VALIDATION.md](VALIDATION.md).

## What this does not protect against

Be clear about these limits:

- **A compromised computer.** Encryption protects data in transit. Malware or
  an administrator on either computer can see the screen, read Orbit's keys, or
  act as you.
- **A leaked invitation.** An invitation is a secret for five minutes and works
  once. Someone in your tailnet who gets it first can pair instead of you.
  Comparing security codes after pairing detects this.
- **Not post-quantum, in practice.** Electron and Node can offer the hybrid
  post-quantum group `X25519MLKEM768`, but the Windows host's TLS stack
  negotiates classical X25519. Recorded traffic could become readable if
  large quantum computers arrive. Tailscale's WireGuard layer is also classical.
- **Metadata.** Tailscale and network observers can see that two devices talk,
  when, and roughly how much. Content is not visible.
- **Key exposure inside one computer.** The host exports its private key to
  Orbit's desktop main process, which uses it for outgoing connections, so the
  key exists in two processes. Moving outgoing TLS into the host is planned.
- **No independent audit yet.** Automated tests check specific properties. They
  are not a security certification. Read [SECURITY.md](../SECURITY.md) for the
  full model and open release gates.
