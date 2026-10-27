<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/logo.svg">
    <img src="docs/assets/brand/logo-light.svg" width="320" alt="Orbit Remote">
  </picture>
  <h1>Your world. Within reach.</h1>
  <p><strong>A native desktop workspace for reaching your own computers over Tailscale: encrypted end to end, hardware-accelerated.</strong></p>
  <p>See your screen as hardware H.264 video, measured at 59 fps on a live 1440p desktop. Take control with permission. Keep every paired device accountable.</p>
  <p>
    <a href="docs/VALIDATION.md"><img src="https://img.shields.io/badge/status-development_preview-d9c38b?style=flat-square" alt="Status: development preview"></a>
    <a href="https://github.com/Optimizer077/orbit-remote/releases/tag/v0.1.0-preview.5"><img src="https://img.shields.io/badge/download-Windows_x64-b2e6c5?style=flat-square" alt="Download: Windows x64 preview"></a>
    <a href="docs/ARCHITECTURE.md"><img src="https://img.shields.io/badge/network-Tailscale-aecaff?style=flat-square" alt="Network: Tailscale"></a>
    <a href="docs/ENCRYPTION.md"><img src="https://img.shields.io/badge/encryption-WireGuard_%2B_mutual_TLS-b2e6c5?style=flat-square" alt="Encryption: WireGuard plus mutual TLS, two layers"></a>
    <a href="docs/ENCRYPTION.md"><img src="https://img.shields.io/badge/identity-pinned_certificates_%C2%B7_revocable-b2e6c5?style=flat-square" alt="Identity: pinned certificates, revocable at any time"></a>
    <a href="#performance"><img src="https://img.shields.io/badge/video-hardware_H.264_%C2%B7_59_fps_measured-aecaff?style=flat-square" alt="Video: hardware H.264 stream, on by default for Windows hosts, 59 frames per second measured live on one PC"></a>
    <a href="docs/MACOS.md"><img src="https://img.shields.io/badge/macOS-Apple_silicon_tested-b2e6c5?style=flat-square" alt="macOS: Apple silicon tested, including a real view-only session with Windows"></a>
  </p>
  <p>
    <a href="https://github.com/Optimizer077/orbit-remote/releases/tag/v0.1.0-preview.5"><strong>Download Windows</strong></a> ·
    <a href="docs/MACOS.md">Continue on a Mac</a> ·
    <a href="docs/ARCHITECTURE.md">How it works</a> ·
    <a href="TODO.md">Roadmap</a> ·
    <a href="CONTRIBUTING.md">Contribute</a>
  </p>
</div>

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-reduced-motion: reduce)" srcset="docs/assets/orbit-flow-narrow-static.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/orbit-flow-narrow.svg">
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/orbit-flow-static.svg">
    <img src="docs/assets/orbit-flow.svg" width="1000" alt="Illustrative Orbit architecture: your computer, a private Tailscale network, and an explicitly paired remote computer">
  </picture>
</p>

> **Public development preview, with explicit limits.** Windows has local runtime evidence. A real view-only session between Windows and an Apple-silicon Mac works in both directions. Since preview.5, Windows hosts stream hardware H.264 video by default (59.3 fps live at 2560×1440 on one PC, still labeled beta in the app) and fall back to images when video can't run. Click-to-screen latency, video between two computers, cross-device control, Intel Macs, and Linux still need measurement or validation. Downloads are unsigned; unattended access before login and production security are not established.

Orbit Remote connects **your own** Windows, macOS, and Linux computers over your private [Tailscale](https://tailscale.com) network. Every installation is both a viewer and a host. Access comes only from an invitation you create, a certificate pinned at pairing, and the permissions the host's owner grants. Orbit runs no server or account, and it never changes your startup, firewall, or Tailscale policy on its own.

<p align="center"><img src="docs/assets/overview.png" width="1000" alt="Orbit Remote desktop workspace"></p>

## Contents

[At a glance](#at-a-glance) · [Why Orbit](#why-orbit) · [How it works](#how-it-works) · [Security](#security) · [Get started](#get-started) · [Features](#features) · [Performance](#performance) · [Themes](#themes) · [Platform support](#platform-support) · [Project status](#project-status) · [Develop](#develop) · [Documentation](#documentation) · [Contributing](#contributing)

## At a glance

| **Private by design** | **Encrypted twice** | **Trust you can check** |
|---|---|---|
| No Orbit server, account, or relay. Your computers reach each other directly over your own tailnet. | Tailscale WireGuard outside, Orbit mutual TLS 1.3 inside. Both sides refuse weaker encryption. | Single-use invitations, pinned certificates, and a security code you compare once by eye. |
| **Permission, not presumption** | **Honest status** | **One app, three systems** |
| View, control, clipboard, files, and power are separate grants that the host enforces and you can revoke. | The viewer shows the encryption actually negotiated. Unsupported states are labeled, never faked. | Windows x64 is exercised today and Windows on ARM builds are ready; Apple-silicon Macs are tested with Windows; Linux awaits device validation. |
| **Hardware-accelerated** | **Light on the network** | **Fails safe** |
| GPU capture, hardware H.264 and hardware decode, on by default for Windows hosts: 59.3 fps at native 2560×1440, measured live on one PC. | About 300 KB/s for a live 1440p screen, against 12.5 MB/s for full images. An idle screen sends almost nothing. | If the stream can't run, Orbit falls back to images. Revoking a device ends its stream within a second. |

## Why Orbit

You have a few computers and want to reach them from each other, without handing your screen to a third party or opening a door to the internet. The usual options each give something up:

| Usual approach | What you give up | What Orbit does instead |
|---|---|---|
| Cloud remote-desktop services | An account and a vendor's broker sit between your computers. | No Orbit server or account. Computers connect directly over **your own** Tailscale network. |
| RDP/VNC ports open to the internet or LAN | An exposed login screen anyone on the network can attack. | Listens only on its Tailscale address, and every peer must hold a certificate you paired explicitly. |
| VPN + RDP | Usually one OS, and all-or-nothing desktop access. | One app for Windows, macOS, and Linux, with **separate grants** for view, control, clipboard, files, and power. |
| "Trust us, it's encrypted" | You can't see what protects you. | **Two encryption layers** you can inspect: the negotiated cipher is shown live, and a security code confirms each pairing. |

Orbit is for reaching your own computers, or ones whose owner explicitly invited you. It is not built for unattended fleet management or for access before anyone has signed in.

## How it works

**Your viewer asks; the host decides.** Every request crosses two encryption layers and four checks on the host before it reaches the desktop.

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/how-it-works-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/how-it-works-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/how-it-works.svg">
    <img src="docs/assets/diagrams/how-it-works-light.svg" width="1000" alt="How a connection works: the viewer's sandboxed window asks Orbit's main process, which connects through Tailscale WireGuard and, inside it, Orbit mutual TLS to the host. The host checks link policy, identity, permissions, and session before reaching the desktop.">
  </picture>
</p>

### What happens when you click Connect

1. **The window asks, the main process acts.** The sandboxed Orbit window can only send allow-listed actions to Orbit's main process. It never sees keys, sockets, or the local control token.
2. **Outbound checks.** The main process accepts only a literal Tailscale IP, offers only strong TLS suites, and presents this computer's certificate.
3. **Nothing goes to an unverified host.** Before a single HTTP byte is sent, the viewer checks the host's certificate against the SHA-256 pin saved at pairing, and checks that the negotiated encryption meets policy.
4. **The host's four gates.** Tailscale delivers only tailnet traffic to port `47832`. The host then ① drops any link below the TLS policy, ② confirms the source with `tailscale whois` and matches the viewer's certificate to an unrevoked pairing, ③ applies that device's grants, and ④ opens a session. One device controls at a time; others can view.
5. **Screen updates.** A Windows host captures the chosen monitor on its GPU, encodes hardware H.264, and sends one continuous video stream over the double-encrypted link; the viewer decodes it in hardware. If video can't run, or the host is a Mac or Linux computer, the host sends images instead. The viewer shows the measured encryption, for example `TLS 1.3 · AES-256-GCM · X25519`.
6. **Input needs two yeses.** The owner must have granted control, and you must choose **Take control**. Input is bounded and coalesced, and held keys are released if the viewer disappears. **Esc** gives control back.
7. **Ending is final.** Disconnect, **Disconnect all**, or a host stop ends the session with `410`, and the viewer never silently reconnects. Revoking the device (`401`) removes its access.

### Architecture, component by component

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/architecture-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/architecture-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/architecture.svg">
    <img src="docs/assets/diagrams/architecture-light.svg" width="1000" alt="Orbit Remote architecture: the viewer computer's Electron app (renderer, preload IPC bridge, main process with transport and controller) sends pinned mutual-TLS requests inside a Tailscale WireGuard tunnel to the host computer's .NET Orbit host, which passes five gates (link policy, Tailscale source check, certificate pin, grants, session) before frame, input, clipboard, file, and power services drive the existing desktop through platform adapters.">
  </picture>
</p>

Every real component in one picture: the Electron app's sandboxed renderer, preload bridge, and main process (`transport.cjs` checks the pin and TLS policy before any byte; `controller.cjs` runs pairing, sessions, frames, and input), the two encryption layers, and the host's five gates, services, stores, and OS adapters. See [the architecture document](docs/ARCHITECTURE.md) for trust boundaries and sequences.

### What runs on each computer

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/processes-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/processes-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/processes.svg">
    <img src="docs/assets/diagrams/processes-light.svg" width="1000" alt="What runs on each computer: a sandboxed Orbit window, the Orbit main process, a local admin API on 127.0.0.1:47831, and the .NET host listening only on the Tailscale address port 47832. One computer reaches the other's host over mutual TLS inside WireGuard.">
  </picture>
</p>

The Orbit window is sandboxed with no Node.js access. Keys and the local control token stay in the main process and the host. The host has a local admin API on `127.0.0.1:47831` (bearer token) for its own app, and listens remotely only on its verified Tailscale address. There is no public or LAN listener, remote shell, or router port forwarding. Read [the architecture](docs/ARCHITECTURE.md) for trust boundaries and how multiple screen windows share one session.

## Security

### Encrypted in layers

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/layers-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/layers-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/layers.svg">
    <img src="docs/assets/diagrams/layers-light.svg" width="1000" alt="Encryption in layers: the Tailscale network boundary, WireGuard, Orbit mutual TLS, and pinned RSA-3072 identities around your screen, keystrokes, clipboard, and files, with keys at rest and stated limits.">
  </picture>
</p>

1. **Network: Tailscale WireGuard.** Only your tailnet devices can reach the host. Traffic between them is encrypted with Curve25519 and ChaCha20-Poly1305, including through Tailscale relays.
2. **Application: Orbit mutual TLS, inside that tunnel.** TLS 1.3, or TLS 1.2 with ECDHE + AES-GCM/ChaCha20-Poly1305 only. Every allowed suite has forward secrecy. The viewer offers only those suites, and the host independently drops anything weaker before reading a request.
3. **Identity: pinned certificates.** Each computer has its own RSA-3072 identity. Pins are checked on every connection, so a changed certificate is blocked as "Device identity changed".
4. **Access: host permissions.** A verified device still gets only what the owner granted.
5. **At rest: protected keys.** Identity keys are encrypted with your Windows account (DPAPI). macOS and Linux use user-only files, with native keychains planned.

Measured against the real Windows host: clients offering only CBC or static-RSA suites were *served* before this policy and are *refused* now. See [How Orbit protects your connection](docs/ENCRYPTION.md).

### Pairing and the security code

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/pairing-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/pairing-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/pairing.svg">
    <img src="docs/assets/diagrams/pairing-light.svg" width="1000" alt="Pairing in six steps: add a device, create a five-minute one-time invitation, send it privately, the viewer checks the certificate fingerprint before sending the secret, the host stores the viewer's pin and grants, and both compare the same security code.">
  </picture>
</p>

The invitation is a secret for five minutes and works once. The viewer verifies the host's certificate **before** revealing that secret. Afterwards both computers show the same eight-group **security code**: compare it once. If someone tampered with the invitation's host details, the codes won't match. A leaked invitation still works only once: if a device you don't recognise appears under the host's devices, revoke it.

### What a paired device can do

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/permissions-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/permissions-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/permissions.svg">
    <img src="docs/assets/diagrams/permissions-light.svg" width="1000" alt="Five grants a paired device can have: View (the default), Control, Clipboard, Files, and Power, and the rules that link them.">
  </picture>
</p>

| Grant | What it allows | Notes |
|---|---|---|
| **View** | See the chosen screen | The default: new invitations are view-only |
| **Control** | Mouse and keyboard | Also needs **Take control** on the viewer; **Esc** releases it |
| **Clipboard** | Read and write text | Explicit actions only, never automatic sync |
| **Files** | Upload and download | One shared folder, no overwrite, 32 MiB per transfer; received files are marked as downloaded from the internet |
| **Power** | Lock or restart | Requires Control, and the host's own policy must allow it |

The host enforces every grant on every request, and the owner can revoke a device at any time.

### Session lifecycle

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/lifecycle-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/lifecycle-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/lifecycle.svg">
    <img src="docs/assets/diagrams/lifecycle-light.svg" width="1000" alt="Session states: Paired to Live via Connect or View only, Live to Controlling via Take control and back via Esc, Reconnecting after a network drop, and final states Ended (HTTP 410) and Revoked (HTTP 401).">
  </picture>
</p>

- **Paired → Live:** choose **Connect** or **View only**.
- **Live ↔ Controlling:** **Take control** (if granted); **Esc** gives it back.
- **Reconnecting:** after a network drop, the session renews with the same identity, and permissions are rechecked.
- **Ended (`410`):** Disconnect, **Disconnect all**, or a host stop. Never resumed automatically, even after a restart.
- **Revoked (`401`):** the owner removed the device; it must be invited again.

### Limits, stated plainly

- It does not protect a compromised computer: malware or an administrator on either end can see what you see.
- It is not post-quantum in practice: the Windows host negotiates classical X25519.
- It has had no independent security audit yet, and the builds are unsigned previews.

Read [SECURITY.md](SECURITY.md) before deployment. Report security concerns privately to the repository owner.

## Get started

### Download for Windows

Get the [preview release](https://github.com/Optimizer077/orbit-remote/releases/tag/v0.1.0-preview.5):

| Download | Use it when |
|---|---|
| `Orbit-Remote-Setup-0.1.0-x64.exe` | You want Orbit installed for your Windows user, with a Start menu shortcut. |
| `Orbit-Remote-Portable-0.1.0-x64.exe` | You want to run one EXE without installing. |
| `SHA256SUMS.txt` | You want to check the download's SHA-256 checksum. |

<details>
<summary>Install notes</summary>

Both EXEs bundle the host and the .NET runtime. You need Tailscale installed and connected, but not Node.js or the .NET SDK. The installer doesn't enable startup, change firewall or Tailscale policy, or launch Orbit when it finishes. The portable app saves settings and its identity in the normal per-user application-data folder. Startup at sign-in is available only in the installed build. Uninstalling keeps your local profile, so pairing keys are never silently deleted.

</details>

These are **unsigned preview builds**, without independent security review or full device validation.

### Connect two computers

1. Run Orbit and Tailscale on both computers. Limit your tailnet policy to the intended devices and TCP port **47832**.
2. On the computer to control, choose **Add a device**, pick permissions, and create an invitation. New invitations are view-only until you enable more.
3. Send the invitation directly to the other computer. It's private, expires in five minutes, and works once.
4. On the viewer, choose **Join with an invite** and paste it.
5. **Compare security codes once:** **Overview → This computer** on the host, and the new device's **⋯** menu on the viewer. They must match exactly.
6. Choose **Connect** or **View only**, then **Take control** if you were granted it. **Esc** releases control.
7. To connect in the other direction, create an invitation on the other computer.

Revoke an incoming device or forget an outgoing one at any time. The tray menu offers **Disconnect all incoming sessions** and **Quit Orbit and stop remote access**.

### Build on macOS or Linux

Install Git, Node.js 24 LTS, the .NET 10 SDK matching `global.json`, and Tailscale. Then:

```bash
git clone https://github.com/Optimizer077/orbit-remote.git
cd orbit-remote
bash scripts/start-dev.sh          # development run
bash scripts/build.sh --package    # native package (DMG on macOS)
```

The script detects Apple silicon or Intel and builds a matching host and package. Read [the Mac handoff](docs/MACOS.md) for privacy permissions and first cross-device tests. Compilation alone does not validate Mac support.

## Features

| Area | What you get today |
|---|---|
| **Workspace** | Overview, Devices, Connections, Activity, and Settings, all showing real host data, plus a **Ctrl/⌘ K command palette** to jump anywhere, connect, or switch themes. |
| **Trust** | Five-minute single-use invitations, pinned certificates, mutual TLS identities, and comparable security codes. A device whose identity changed is blocked, and the app says so. |
| **Encryption** | WireGuard + mutual TLS 1.3 (or 1.2 ECDHE + AEAD). Weaker links are refused, and the negotiated encryption is shown live. |
| **Permissions** | Separate view, control, clipboard, files, and power grants, enforced on the host. |
| **Streaming** | Hardware H.264 video from Windows hosts, on by default: GPU capture, low-latency hardware encoding, and hardware decoding in the viewer. Images when video can't run. |
| **Viewer** | Full-window viewer with **Fit** / **1:1** and native fullscreen, pop-out windows for other host displays, a **smoothness meter** and **Connection details**, and a cursor drawn locally by the viewer. Keyboard focus is visible, and reconnects are announced to screen readers. |
| **When the remote changes** | If the remote display is asleep, the viewer says **Display asleep** instead of showing a frozen picture, releases held keys, and checks again every few seconds. With control permission you can press **Wake display** (once every 5 s; not in view-only sessions). Updates pause while the window is minimized, and **Reconnect** is one click after a host restart. |
| **Input** | Native keyboard and mouse, explicit **Take control**, bounded queues, automatic release of held keys, and modifier keys applied on Mac hosts. |
| **Sharing** | Many viewers, one controller, revocation, and **Disconnect all**. A device you disconnected shows **Disconnected by you · Allow again**. A host-ended session is never auto-resumed. |
| **Clipboard & files** | Explicit text clipboard; one chosen transfer folder, no overwrite, 32 MiB per transfer, timeouts that scale with file size. Received files are marked as downloaded from the internet. |
| **Power** | Optional lock and restart, gated by host policy and the device's grant. |
| **Reliability** | Host supervision, owner-exit shutdown, bounded shutdown and drain, per-device and per-host stream limits, and renewal that rechecks identity and permissions. |
| **Hardening** | The installed app can't be run as Node.js, ignores `NODE_OPTIONS` and inspect flags, and loads only from its integrity-checked archive. |

Audio is not implemented.

## Performance

Windows hosts stream hardware H.264 video by default. The host captures the screen on the GPU with DXGI Desktop Duplication, encodes it with the GPU's H.264 encoder through Windows Media Foundation (low-latency mode, no B-frames), and sends one continuous stream inside the pinned mutual-TLS link. The viewer decodes it with WebCodecs, which Chromium backs with D3D11VA on Windows, VideoToolbox on macOS, and VA-API on Linux. If video can't run, the session falls back to images.

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/assets/diagrams/pipeline-narrow.svg">
    <source media="(max-width: 767px)" srcset="docs/assets/diagrams/pipeline-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/pipeline.svg">
    <img src="docs/assets/diagrams/pipeline-light.svg" width="1000" alt="The hardware streaming pipeline, measured per stage at 3024 by 1898: GPU capture 4.4 ms per changed frame, hardware H.264 encode 5.8 to 7.6 ms (2.5 to 2.9 ms at 1080p), one stream of 2 to 26 KB per update inside the pinned mutual-TLS link, hardware decode 0.5 to 0.7 ms (2.4 to 3.3 ms on a Mac), and drawing in 0.2 ms. Measured live on one PC: 59.3 frames per second at native 2560 by 1440 with about 300 KB/s. Click-to-screen latency is not measured yet.">
  </picture>
</p>

### Measured

Every result comes from one Windows PC with an NVIDIA RTX GPU, except the Mac decode figure. Per-stage timings are medians on synthetic screen content.

| What | Result | How it was measured |
|---|---|---|
| GPU capture | 4.4 ms per changed frame; an unchanged screen costs almost nothing | Per stage, 3024×1898 |
| Hardware encode | 2.5–2.9 ms per 1080p frame; 5.8–7.6 ms at 3024×1898 | Per stage, NVIDIA encoder |
| Viewer decode | 0.5–0.7 ms; 2.4–3.3 ms on an Apple-silicon Mac | Per stage, 1080p and 3024×1898 |
| Draw | 0.2 ms | Per stage, canvas |
| **Live stream** | **59.3 fps at native 2560×1440**, about 300 KB/s | A real desktop for 30 s (1,780 frames), host and viewer on the same PC. Images on the same screen: about 20 fps at 12.5 MB/s |
| Synthetic stream | 3601 of 3601 frames at 60.0 fps; frame interval p95 17.7 ms | A generated 60 fps test source through the full pipeline for 60 s |
| Two viewers | Both held 60 fps | The same synthetic test, two viewers at once |

| Recovery | Time |
|---|---|
| Video back after the host restarts | About 0.45 s after the restarted host is healthy (1.9 s from stopping it) |
| One-click **Reconnect** | About 0.42 s |
| Change quality without restarting the stream | About 0.13–0.15 s |
| Capture reset | About 0.15 s gap |

### Not measured yet

- **Click-to-screen latency.** The stage times add up to about 11–13 ms per frame plus the network. That sum is not a latency measurement.
- **Video between two computers.** All stream results above come from one PC. Windows video has reached a Mac viewer, but sustained cross-device playback has not been measured.
- **AMD and Intel encoders.** Only an NVIDIA encoder has been measured.
- **Mac and Linux hosts.** They have no video stream yet and send images.
- **Very busy screens.** Noisy, fast-changing content can exceed the bitrate target.

Methods, sample sizes, and caveats are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Every experiment, including failed runs, rejected approaches, and the decisions they led to, is recorded in [docs/RESULTS.md](docs/RESULTS.md).

## Themes

Pick a theme in **Settings** or with the command palette (**Ctrl/⌘ K**). By default Orbit follows your system: **Daylight** in light mode, **Graphite** in dark mode.

| Daylight | Graphite |
|:---:|:---:|
| <a href="docs/assets/overview.png"><img src="docs/assets/overview.png" width="440" alt="Daylight theme: bright, crisp surfaces with a teal accent"></a> | <a href="docs/assets/graphite.png"><img src="docs/assets/graphite.png" width="440" alt="Graphite theme: neutral dark greys with a vivid teal accent"></a> |
| **Midnight** | **Paper** |
| <a href="docs/assets/midnight.png"><img src="docs/assets/midnight.png" width="440" alt="Midnight theme: deep navy with blue accents"></a> | <a href="docs/assets/paper.png"><img src="docs/assets/paper.png" width="440" alt="Paper theme: warm light paper tones"></a> |

Every theme meets WCAG AA text contrast, uses no text smaller than 12 px, and respects reduced motion. The [brand guide](docs/BRAND.md) covers the logo, icons, palette, type, and motion.

## Platform support

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Desktop GUI | Exercised locally | Exercised on Apple silicon ([Mac record](docs/MACOS-VALIDATION.md)) | Needs native build/test |
| Unlocked capture | GPU (DXGI) with GDI fallback, exercised | Native helper, exercised with Screen Recording consent (Retina + external display) | X11 + ffmpeg |
| Hardware video stream | H.264 host, measured with an NVIDIA GPU | Viewer decode measured; Mac hosts send images | Hosts send images |
| Input | SendInput adapter | CoreGraphics + Accessibility, exercised | X11 + xdotool |
| Text clipboard | Win32 | pbcopy/pbpaste, exercised | X11 + xclip |
| Locked/sign-in/UAC screen | **Unsupported** | **Unsupported** | **Unsupported** |
| Startup at user sign-in | Installed build option | Packaged option, needs validation | Deployment work remains |
| Boot before user login | **Not implemented** | **Not implemented** | **Not implemented** |
| Wayland | N/A | N/A | **Unsupported; fails closed** |

## Project status

| Status | What that means today |
|---|---|
| **Exercised locally** | Windows capture, the hardware video stream on one PC, certificate-authenticated loopback sessions, pairing and revocation, link policy, themes, and packaged-app recovery. See the [validation record](docs/VALIDATION.md). |
| **Native evidence and remaining validation** | Apple silicon Mac adapters were exercised locally ([Mac record](docs/MACOS-VALIDATION.md)), and a real view-only Windows ↔ Mac session was tested in both directions on preview.4 ([validation record](docs/VALIDATION.md)). Video between two computers, cross-device control, Intel Macs, and Linux remain pending. |
| **Planned / unsupported** | Locked and sign-in screens, access before login, Wayland, virtual monitors, video from Mac and Linux hosts, audio, and signed updates. See [next steps](TODO.md). |

This public repository carries product source snapshots and preview downloads. See the [validation record](docs/VALIDATION.md), [changelog](CHANGELOG.md), and [roadmap](TODO.md) for evidence and remaining work.

## Develop

```powershell
# Windows
.\scripts\start-dev.ps1
.\scripts\check.ps1
.\scripts\build.ps1 -Runtime win-x64 -Package
```

```bash
# macOS / Linux
bash scripts/start-dev.sh
dotnet run --project tests/Orbit.Host.Tests/Orbit.Host.Tests.csproj
cd apps/desktop && npm test && npm run build
```

For local-only testing, use `start-dev.ps1 -LoopbackTest` or `start-dev.sh --loopback-test`. This binds remote TLS to loopback and labels the UI **Local test mode**. Run the Windows checks above for the native host, desktop, build, and Electron tests. On a Mac, `bash scripts/check-mac.sh` runs the native and desktop checks.

<details>
<summary>Repository map</summary>

```text
apps/desktop/renderer/            Interface, themes, About, and motion
apps/desktop/electron/            Bridge, TLS client, sessions, supervision
apps/desktop/build/icons/         App and tray icons (optical small sizes)
apps/desktop/electron-builder.cjs Installer and host-bundle checks
src/Orbit.Host/                   Host, trust, permissions, files, audit
src/Orbit.Host/Platform/          Native OS adapters
tests/Orbit.Host.Tests/           Real TLS and native-boundary checks
scripts/                          Windows and Unix launch/build workflows
docs/                             Architecture, encryption, protocol, validation, brand
```

Packaging checks each executable's real OS and architecture; build native packages on their target OS. Linux needs a signed-in X11 desktop, logind, ffmpeg with x11grab, xdotool, xrandr, and xclip. `docs/ci-example.yml` is a CI template, not active CI.

</details>

## Documentation

| Use Orbit | Understand the system | Help build it |
|---|---|---|
| [Mac development handoff](docs/MACOS.md) | [Architecture and trust boundaries](docs/ARCHITECTURE.md) | [Prioritized checklist](TODO.md) |
| [Security model](SECURITY.md) | [How your connection is encrypted](docs/ENCRYPTION.md) | [Contribution guide](CONTRIBUTING.md) |
| [Validation record](docs/VALIDATION.md) | [Pairing and API protocol](docs/PROTOCOL.md) | [Release plan](docs/PLAN.md) |
| [Changelog](CHANGELOG.md) | [Performance and measurement](docs/PERFORMANCE.md) | [Brand guide](docs/BRAND.md) |
| | [Experiments, results and decisions](docs/RESULTS.md) | |
| | [Extra screens and virtual displays](docs/VIRTUAL_DISPLAYS.md) | [Contribution guide](CONTRIBUTING.md) |

## Contributing

Start with a small item from [TODO.md](TODO.md) and follow [CONTRIBUTING.md](CONTRIBUTING.md). Mac device testing, permission recovery, and reproducible performance measurements are especially welcome. Record the OS and hardware you actually exercised: compilation or a mock does not establish native support.

Each computer generates its own identity. **Never copy keys or application-data folders between computers, or commit them.**

Public releases contain reviewed product snapshots. Report reproducible issues through the public repository and follow [CONTRIBUTING.md](CONTRIBUTING.md); report security concerns privately as described in [SECURITY.md](SECURITY.md).

No software license is declared yet; license selection is tracked in the checklist. This preview is not a production security certification.
