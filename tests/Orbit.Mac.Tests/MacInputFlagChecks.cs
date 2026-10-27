using System.Runtime.Versioning;
using Orbit.Host.Platform;

[SupportedOSPlatform("macos")]
internal static class MacInputFlagChecks
{
    internal static void Run(Action<bool, string> check)
    {
        const ulong other = (1UL << 16) | (1UL << 21) | (1UL << 23) | (1UL << 8);
        HashSet<ushort> empty = [];
        foreach (var (left, right, mask, name) in new (ushort, ushort, ulong, string)[]
        {
            (56, 60, 1UL << 17, "Shift"), (59, 62, 1UL << 18, "Control"),
            (58, 61, 1UL << 19, "Option"), (55, 54, 1UL << 20, "Command")
        })
        {
            check(MacPlatformBackend.InputEventFlags(mask | other, empty) == other, $"Stale host {name} cannot modify an unmodified remote key");
            check(MacPlatformBackend.InputEventFlags(other, empty, left, true) == (mask | other), $"Left {name} down applies before OS dispatch");
            check(MacPlatformBackend.InputEventFlags(other, empty, right, true) == (mask | other), $"Right {name} down applies before OS dispatch");
            check(MacPlatformBackend.InputEventFlags(mask | other, new HashSet<ushort> { left }, left, false) == other, $"{name} key-up clears a stale creation-time flag");
            check(MacPlatformBackend.InputEventFlags(mask | other, new HashSet<ushort> { left, right }, left, false) == (mask | other), $"Releasing left {name} retains the held right key");
            check(MacPlatformBackend.InputEventFlags(other, new HashSet<ushort> { left }, 0, true) == (mask | other), $"Ordinary remote key retains held {name}");
            check(MacPlatformBackend.InputEventFlags(mask | other, new HashSet<ushort> { left }, releasing: true) == other, $"Forced release clears {name} without altering other flags");
        }
        const ulong all = (1UL << 17) | (1UL << 18) | (1UL << 19) | (1UL << 20);
        HashSet<ushort> combined = [56, 59, 58, 55];
        check(MacPlatformBackend.InputEventFlags(other, combined) == (all | other), "Pointer/wheel flags include all held remote modifiers");
        check(MacPlatformBackend.InputEventFlags(all | other, combined, 59, false) == ((all & ~(1UL << 18)) | other), "Control release preserves the other held modifiers");
        check(MacPlatformBackend.InputEventFlags(all | other, combined, releasing: true) == other, "Forced release removes all momentary modifiers and preserves Caps/Fn/keypad flags");
    }
}
