# Extra screens and virtual workspaces

**Status: design and engineering roadmap. Orbit does not currently create, resize, or remove virtual monitors.** The preview enumerates existing displays and lets a viewer select one. The proposed feature would let an authorized viewer request an extra screen on a host when its OS and installed provider support it. This document does not install a driver or change any computer's display arrangement.

## What the feature means

| Mode | What the user gets | Boundary |
|---|---|---|
| Existing display | View a monitor already present on the host. | Current preview foundation; native validation varies by OS. |
| Extend desktop | Add another monitor to the same signed-in desktop and drag existing applications onto it. | Requires an OS-specific monitor provider. |
| Mirror | Display a copy of existing content. | Does not add usable desktop space. |
| Separate workspace | Start applications in another desktop session or virtual machine. | Different processes/session; existing windows do not automatically move into it. |
| OS virtual desktop / Space | Organize windows in another workspace on the existing displays. | Does not create another monitor or an independent concurrent login. |

Example: control a Windows host from a Mac and choose **Add extra screen**. Windows receives a new monitor, a viewer window displays it, and applications can move there. The monitor exists on the **Windows host**; it does not extend the Mac's own desktop. Using another computer as a monitor for your local computer reverses the host/viewer roles.

An extra monitor is useful for a laptop-sized viewer, a headless workstation, dedicated tools, or a second remote work area. It does **not** make the session private from other users or programs on the host, and it does not solve FileVault/BitLocker preboot, UAC, locked-screen control, or multi-user isolation.

## Architecture

1. The viewer requests an extra screen over the existing pinned mutual-TLS connection inside Tailscale.
2. Host policy and a separate new-display grant decide; the host owner must have enabled and approved it locally.
3. An approved request gets a bounded, per-session display lease.
4. The lease asks the native monitor provider to add an output to the OS display topology.
5. That display is captured and encoded like any other and sent to the viewer.
6. Expiry, revocation or disconnect triggers cleanup, which tells the provider to remove the output.

Monitor creation belongs behind a narrow host-managed interface. The renderer never installs a driver or sends arbitrary native commands. The Windows provider should be a separate native project; the existing .NET host can manage it through restricted authenticated IPC. Linux portal handling needs a native/session helper. Each provider reports its actual installed version and capabilities. Unsupported providers return a clear reason without manufacturing a display in the UI.

Proposed contract, **not implemented API**:

```csharp
public interface IVirtualDisplayProvider
{
    Task<VirtualDisplayCapability> ProbeAsync(CancellationToken cancellationToken);
    Task<VirtualDisplayLease> CreateAsync(
        AuthorizedDisplayRequest request, CancellationToken cancellationToken);
    Task ReleaseAsync(string leaseId, CancellationToken cancellationToken);
}
```

`AuthorizedDisplayRequest` must be constructed inside the host after authentication, host-policy and permission checks. Bind the lease to the authenticated device, OS user/session, remote session, provider-owned stable ID, validated mode, expiry, and quota. Never accept an arbitrary OS display ID as proof of ownership. Renewing a display lease must recheck authorization; it cannot outlive remote access. Resizing is a later negotiated operation with fresh bounds and topology checks.

## Platform decisions

### Windows: native indirect display driver

Use Microsoft's **Indirect Display Driver model (IddCx)**. It supports reporting monitors and modes and receiving desktop frames as DirectX surfaces. The driver uses UMDF and runs separately from the interactive application. Start with a dedicated driver-host process, one 1920 x 1080 SDR output, and tested Windows 11 builds; determine the exact Windows 10 compatibility baseline from the IddCx version actually used. [Microsoft IDD overview](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview), [official sample](https://github.com/microsoft/Windows-driver-samples/tree/main/video/IndirectDisplay)

Driver distribution is separate from signing the Orbit application. Build the DLL/INF/catalog package with the WDK, define an appropriate release-signing/certification path for that driver, and validate installation and removal under normal Windows protections. Microsoft documents package-integrity signatures, submission requirements, and elevated device-management tooling. Do not assume a kernel-driver-only signing rule applies identically to this user-mode package. [Driver signing](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/driver-signing), [dashboard requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-reqs), [PnPUtil](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax)

Ship the provider as an optional, explicitly installed component. Portable Orbit must work without it. Do not lower Secure Boot, disable signature enforcement, enable test-signing on a user's everyday machine, or replace unrelated display drivers. Development-driver tests belong on a designated test machine with a recovery route. Installation requires a deliberate local privileged action; remote sessions cannot install drivers.

### macOS: capture first, research host creation separately

ScreenCaptureKit is the supported direction for efficient capture of displays, windows, and applications. Capturing an existing display and adding a new display are separate operations. Apple's Virtualization graphics APIs configure displays **inside a guest virtual machine**; they do not provide extra monitors for the host's existing desktop. [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), [Virtualization graphics](https://developer.apple.com/documentation/virtualization/graphics)

No supported host-monitor creation path has been selected or validated for Orbit. `CGVirtualDisplay` experiments are possible, but Chromium's test implementation declares interfaces generated from CoreGraphics binaries; that is not an Apple-documented compatibility contract. Treat such a backend as an isolated research project, disabled by default, with explicit OS-version tests and no stability promise. Do not claim that a generic DriverKit entitlement guarantees a public display-driver solution. [Chromium's virtual-display test implementation](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/display/mac/test/virtual_display_util_mac.mm)

The Mac handoff should first establish ScreenCaptureKit, permissions, Retina input mapping, and real Mac/Windows sessions. Capture of a user-configured additional display can be investigated independently of Orbit creating it. Screen Recording and Accessibility consent remain required where applicable; adding an output cannot bypass them.

### Linux: distinguish desktop extension from another session

On Wayland, inspect `org.freedesktop.portal.ScreenCast.AvailableSourceTypes`. The specification defines `VIRTUAL = 4` for a new virtual monitor, but Orbit must check what the installed portal/backend advertises and prove the selected compositor supports it. Combined capture/control uses a RemoteDesktop session and the actually granted devices. Prefer EIS input where supported. Preserve portal prompts and manage restore tokens as revocable authorization data. [ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html), [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

On X11, support depends on the active display server/driver. An `xrandr` monitor description is not proof that a new usable output was created. **Xvfb** runs a virtual framebuffer X server; **Xephyr** runs a nested X server in an existing display window. These are useful separate-workspace options, rather than an extra output attached to the user's existing desktop. Use private authentication, local sockets, and explicit process/session ownership; never launch an unauthenticated network-listening X server. [X.Org server descriptions](https://www.x.org/releases/X11R7.5/doc/RELNOTES.pdf)

## Permission and privacy rules

- Add a separate `ManageDisplays` grant, disabled by default, plus a local host setting. Existing View/Control grants must not silently gain it. Old profiles migrate to denied.
- Require a valid view session for creation; input still needs the separate control grant. Initially allow one owner and one temporary display per host session.
- Enforce the selected output's bounds on the host before accepting input. The current desktop-wide pointer guard is insufficient to claim display-scoped input isolation. Coordinate mapping must use fresh topology and account for negative origins, scale, rotation, and points versus pixels.
- Never turn off a physical monitor, change the primary monitor, blank the host, or move unrelated windows as a side effect of **Add extra screen**. Any future privacy mode needs its own design and explicit local policy.
- Display contents may remain observable locally; windows may return to physical monitors when an output disappears. Explain that removal may rearrange windows. A private workspace needs a stronger session/VM isolation design.
- Limit monitor count, dimensions, refresh, queued frames, memory, create frequency, and lease lifetime. Validate all requests before passing them to native code.
- Audit creation/removal/rejection/provider failure using identities, mode, and reason. Do not record screen contents or titles. Keep credentials and restore tokens out of the renderer and logs.

## Lifetime and recovery

| From | To | When |
|---|---|---|
| (start) | Probing | — |
| Probing | Unavailable | Provider missing or unsupported |
| Probing | Ready | Provider verified |
| Ready | Authorizing | Explicit request |
| Authorizing | Ready | Denied, canceled or expired |
| Authorizing | Creating | Policy and consent granted |
| Creating | Active | Output and capture verified |
| Creating | Cleaning | Partial failure or cancellation |
| Active | Cleaning | Revoke, expiry, disconnect or shutdown |
| Cleaning | Ready | Owned output removed |
| Cleaning | RecoveryRequired | Provider failure |
| RecoveryRequired | Ready | Ownership reconciliation succeeds |

Release held input before stopping capture/removing the output. Revoke access immediately on disconnect; initial policy removes the temporary output immediately. Cleanup is idempotent and bounded. If it fails, show **Recovery required**, retry safely, and expose a local removal action. Do not report success merely because a request was sent.

Keep a minimal user-protected ownership journal for crash recovery. On startup compare the journal, provider state, active OS session, and currently connected physical displays; remove only abandoned Orbit-owned outputs. Never blindly restore an old topology snapshot over physical hotplug or user changes. Hard crashes and restarts require provider-level recovery tests; a lease in the GUI alone is insufficient.

## Performance and validation gates

Start at one 1080p SDR output with conservative refresh. One raw 1080p BGRA frame is about 8.3 MB; 60 frames/second is about 498 MB/s before transport. More monitors increase capture, encode, memory, and bandwidth cost. Pair this work with GPU-backed capture, hardware video, bounded queues, and adaptive quality; virtual displays alone do not accelerate the current PNG polling. Advertise measured resolution/frame rate/latency rather than a target as delivered performance.

Prioritized engineering checklist:

1. **P0: finish existing-device validation.** Prove Mac/Windows capture, input, revocation, monitor hotplug, and recovery before introducing a native driver dependency.
2. **P1: capability and policy foundation.** Implement the provider contract, honest availability/reasons, denied-by-default grant migration, quotas, lease ownership, topology events, and host-enforced display bounds. Add meaningful tests for denial, stale IDs, cancellation, orphan reconciliation, and cleanup failure.
3. **P1: Windows laboratory provider.** Separate WDK project based on the official model, unique driver-host group, one fixed-mode output, restricted broker protocol, and crash/removal tests. Review sample licensing before reuse.
4. **P1: Windows distribution gate.** Complete package signing/install/upgrade/uninstall, normal security-policy validation, clean-machine checks, and explicit optional-component UX before including a driver in a release.
5. **P2: Linux portal backend.** Probe virtual-source support, integrate portal/PipeWire/EIS lifecycle and consent, and certify exact compositor/backend versions. Keep separate-workspace mode distinct.
6. **P2: Mac research gate.** Evaluate host creation, document Apple-supported options or private-API risks, and test exact macOS/hardware. Keep unsupported states visible until a provider passes the same lifecycle tests.
7. **P2: richer outputs.** Negotiated resize, multiple outputs, HiDPI, rotation, cursor metadata, frame pacing, resource budgeting, and a tested headless path. HDR/color fidelity follow separate tests.

Acceptance requires real-device evidence: create, OS enumeration, move an application, capture the correct output, input at edges, grant denial, revoke, disconnect, process kill, sleep/wake, physical hotplug, reconnect, reboot, and uninstall. Record exact OS, GPU, display layout, provider/build version, source commit, permissions, memory/CPU/GPU use, measured frame timing, and direct/relayed Tailscale path in [VALIDATION.md](VALIDATION.md). A diagram, capability placeholder, driver compilation, or simulated monitor does not pass these gates.
