# Contributing to Orbit Remote

Orbit is a public development preview. The most useful contributions help establish what works on real devices, repair a specific failure, or make a permission boundary easier to verify. Begin with [TODO.md](TODO.md) and the [architecture](docs/ARCHITECTURE.md).

No software license is currently declared. Public source access does not itself establish reuse or contribution terms. License selection is tracked in the roadmap; discuss the intended terms with the repository owner before submitting substantial code or third-party assets.

## Start on your computer

Install Git, Node.js 24 LTS, the .NET 10 SDK matching [`global.json`](global.json), and Tailscale. Use native architecture tools, especially on Apple silicon. Each computer must generate its own Orbit identity; never copy development profiles, keys, or pairing state between devices.

```bash
git clone https://github.com/Optimizer077/orbit-remote.git
cd orbit-remote
```

Windows:

```powershell
.\scripts\start-dev.ps1
.\scripts\check.ps1
```

macOS / Linux:

```bash
bash scripts/start-dev.sh
dotnet run --project tests/Orbit.Host.Tests/Orbit.Host.Tests.csproj
cd apps/desktop
npm test
npm run build
```

Read [MACOS.md](docs/MACOS.md) before a first Mac run. Mac and Linux backends need native validation. Build packages on their target operating system; a successful cross-platform compilation does not prove capture, input, OS consent, or package launch.

The Windows Electron smoke test is `npm run test:ui` from `apps/desktop`. It uses temporary profiles, isolated ports, and loopback-only pairing. Quit an existing Orbit instance first. Do not represent this test as Mac/Linux, internet-path, or real-input validation. Consult [VALIDATION.md](docs/VALIDATION.md) for exactly what existing checks establish.

## Report a reproducible problem

For an ordinary bug, include:

- Source commit or download filename, OS/build, CPU architecture, and whether the app was installed, portable, or run from source.
- Viewer and host roles, exact steps, expected behavior, actual behavior, and whether it repeats.
- Monitor resolution, scaling/Retina, rotation/layout, keyboard layout, and relevant OS consent state.
- Whether Tailscale was direct, DERP-relayed, or peer-relayed during the failure; include interruptions or sleep/wake if relevant.
- A short redacted log excerpt or screenshot when useful, and the steps that restored access.

Remove invitation strings, tokens, private certificates, usernames, device names/addresses when sensitive, clipboard contents, and private screen/file content. Do not attach the entire application-data directory or connection profile. Small sanitized reproductions are easier to review.

For Mac results, follow the checklist in [MACOS.md](docs/MACOS.md) and record the exact hardware/macOS version, Apple silicon or Intel, source commit, launch mode, and which process received Screen Recording and Accessibility approval. Report Windows-to-Mac and Mac-to-Windows separately. Test view-only first; intentionally enable input and data channels afterward. Include denial, revoked consent, focus loss, display changes, disconnect, and recovery observations.

## Keep changes reviewable

Choose one concrete problem. Explain the trigger, resulting behavior, and evidence for the fix. Run the checks relevant to your change, report the actual results and platform, and add a meaningful regression check when the failure warrants it. Preserve the lockfile and explain any dependency change.

Changes to pairing, IPC, native code, or a data channel must preserve host-enforced grants and revocation. New screen windows must remain attached to the correct session and monitor context. Include denied access, stale sessions, queued work, disconnect, and held-input cleanup in the review. Read [SECURITY.md](SECURITY.md) before changing these boundaries.

Do not add general remote commands, automatic privilege escalation, a public listener fallback, copied identities, or silent permissions/startup changes. Virtual monitor creation has its own [provider and cleanup design](docs/VIRTUAL_DISPLAYS.md); opening another viewer window only shows an existing display.

Performance changes need a repeatable workload and measurements from [PERFORMANCE.md](docs/PERFORMANCE.md). Label targets and estimates. Do not turn a configuration value, loopback run, or compilation into an advertised FPS, latency, or platform-support result.

For interface work, follow [BRAND.md](docs/BRAND.md), preserve all three themes, keyboard focus, contrast, and reduced-motion behavior. Include screenshots with no private desktop content or live invitation secrets.

## Report security concerns privately

Contact the repository owner privately for a suspected vulnerability. No dedicated reporting address is configured. If GitHub offers **Report a vulnerability** for this repository, use that private route; otherwise arrange a private channel with the owner before sending technical details.

Do not publish a vulnerability, exploit, live invitation, private key, or affected user information in an issue, pull request, screenshot, or public discussion. An initial private report should describe the affected version, boundary involved, impact, and a minimal sanitized reproduction. Follow [SECURITY.md](SECURITY.md) for the project's current scope and limitations.
