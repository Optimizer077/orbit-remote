# Mac native capture pipe — framing slice

This directory currently specifies the helper protocol and its independent
golden header fixture. The managed reader is `MacCaptureProtocol.cs`, exercised
by the Mac harness's `--capture-pipe` option. No native capture producer,
process launcher, backend selection or permission change is implemented here yet.

See the [Mac setup guide](../../docs/MACOS.md) for current platform support. The future Swift helper
uses OS ScreenCaptureKit, anonymous pipes, no audio, a 30 Hz raw ceiling and
demand credits. Compressed VideoToolbox output follows separately.

All header integers are big-endian. Header length is exactly 64 bytes:

| Offset | Field | Type |
|---:|---|---|
| 0 | ASCII `ORBC` | 4 bytes |
| 4 | Version = 1 | u16 |
| 6 | Record kind | u16 |
| 8 | Header length = 64 | u32 |
| 12 | Payload length | u32 |
| 16 | Per-launch nonzero generation | u64 |
| 24 | Strictly increasing delivery sequence | u64 |
| 32, 36 | Width, height | u32 each |
| 40 | Raw tight row stride, or zero | u32 |
| 44 | Pixel format / codec enum | u32 |
| 48 | Capture timestamp, monotonic nanoseconds | u64 |
| 56 | Configured nonzero stream slot | u32 |
| 60 | Flags | u32 |

Kinds: raw frame=1, heartbeat=2, permission unavailable=3, display changed=4,
error=5, compressed access unit=6. Formats: none=0, BGRA32=1, H.264 Annex-B=2,
HEVC Annex-B=3. Only compressed records may set flag bit0 (keyframe); all other
flag bits are invalid. The access-unit envelope checks an Annex-B prefix; it
does not implement or validate a video codec.

Raw width/height must exactly match the parent's immutable display binding,
stride must be width×4, and payload must equal stride×height. At most two stream
bindings share the existing 128 MiB raw-memory budget; two 4K displays fit. Coded
geometry is bounded separately, with physical geometry retained in the binding;
access units are capped at 8 MiB. Codec configuration/cropping remains a later
slice, and no compressed path is enabled by defining these enums.

Control records have zero payload, geometry, stride, format, timestamp and flags.
Heartbeat retains demand. Permission/display/error records surface their state
and retire the reader, so subsequent old pixels cannot be accepted. Clean EOF,
malformed/truncated records and interrupted reads also require a new reader.
The caller must then dispose the pipe/child and use a fresh launch generation.

`TryGrant(slot)` returns true once per outstanding frame. Only a true result
authorizes sending one `grant(slot,1)` command. Credits do not accumulate, and a
frame is refused before payload allocation if no credit exists. Credit is spent
only after a complete validated body. The reader allows one in-progress read;
per-viewer cancellation must cancel the broker waiter, not a shared pipe read.

The future stdin command line will be bounded to 512 bytes, versioned and
allowlisted (`init`, `grant`, `stop`); it accepts no path, shell command or
arbitrary native property. Generation is represented as 16 hexadecimal digits
in JSON to avoid floating-point loss. Native command parsing is not implemented
in this slice.

`fixtures/raw-v1-header.hex` encodes a 1×1 raw frame with sentinel generation,
sequence and timestamp values. It contains no captured image. Future Swift
producer tests must match this exact fixture, then exercise a synthetic pipe
exchange against the managed reader before real capture starts.
