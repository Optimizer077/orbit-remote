using System.Runtime.InteropServices;
using System.Runtime.Versioning;

// Test-only, read-only inventory. No key bytes, certificates, labels, account
// names or item attributes are inspected or returned; only array counts leave
// the native query. Search is restricted to the user's login keychain.
[SupportedOSPlatform("macos")]
internal static class LoginKeychainCounts
{
    private const string Security = "/System/Library/Frameworks/Security.framework/Security";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    private static readonly IntPtr SecurityHandle = NativeLibrary.Load(Security);
    private static readonly IntPtr FoundationHandle = NativeLibrary.Load(CoreFoundation);
    private static IntPtr Constant(string name) => Marshal.ReadIntPtr(NativeLibrary.GetExport(SecurityHandle, name));

    internal static object Read()
    {
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Keychains", "login.keychain-db");
        var status = SecKeychainOpen(path, out var keychain);
        if (status != 0) throw new InvalidOperationException($"Cannot inventory login keychain (OSStatus {status}).");
        try
        {
            return new { certificates = Count(keychain, "kSecClassCertificate"), keys = Count(keychain, "kSecClassKey"),
                identities = Count(keychain, "kSecClassIdentity"), orbitCertificates = Count(keychain, "kSecClassCertificate", "Orbit Remote") };
        }
        finally { CFRelease(keychain); }
    }

    private static long Count(IntPtr keychain, string itemClass, string? subject = null)
    {
        var query = CFDictionaryCreateMutable(IntPtr.Zero, 0,
            NativeLibrary.GetExport(FoundationHandle, "kCFTypeDictionaryKeyCallBacks"),
            NativeLibrary.GetExport(FoundationHandle, "kCFTypeDictionaryValueCallBacks"));
        var searchList = CFArrayCreate(IntPtr.Zero, [keychain], 1, NativeLibrary.GetExport(FoundationHandle, "kCFTypeArrayCallBacks"));
        var subjectString = subject is null ? IntPtr.Zero : CFStringCreateWithCString(IntPtr.Zero, subject, 0x08000100);
        try
        {
            CFDictionarySetValue(query, Constant("kSecClass"), Constant(itemClass));
            CFDictionarySetValue(query, Constant("kSecMatchSearchList"), searchList);
            CFDictionarySetValue(query, Constant("kSecMatchLimit"), Constant("kSecMatchLimitAll"));
            // Return opaque item references only, never kSecReturnData or attributes.
            CFDictionarySetValue(query, Constant("kSecReturnRef"), Marshal.ReadIntPtr(NativeLibrary.GetExport(FoundationHandle, "kCFBooleanTrue")));
            CFDictionarySetValue(query, Constant("kSecUseAuthenticationUI"), Constant("kSecUseAuthenticationUIFail"));
            if (subjectString != IntPtr.Zero) CFDictionarySetValue(query, Constant("kSecMatchSubjectContains"), subjectString);
            var status = SecItemCopyMatching(query, out var result);
            if (status == -25300) return 0; // errSecItemNotFound, not a query failure.
            if (status != 0) throw new InvalidOperationException($"Login keychain inventory failed (OSStatus {status}).");
            try { return CFArrayGetCount(result); }
            finally { CFRelease(result); }
        }
        finally
        {
            if (subjectString != IntPtr.Zero) CFRelease(subjectString);
            CFRelease(searchList); CFRelease(query);
        }
    }

    [DllImport(Security)] private static extern int SecKeychainOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string path, out IntPtr keychain);
    [DllImport(Security)] private static extern int SecItemCopyMatching(IntPtr query, out IntPtr result);
    [DllImport(CoreFoundation)] private static extern IntPtr CFDictionaryCreateMutable(IntPtr allocator, nint capacity, IntPtr keys, IntPtr values);
    [DllImport(CoreFoundation)] private static extern void CFDictionarySetValue(IntPtr dictionary, IntPtr key, IntPtr value);
    [DllImport(CoreFoundation)] private static extern IntPtr CFArrayCreate(IntPtr allocator, IntPtr[] values, nint count, IntPtr callbacks);
    [DllImport(CoreFoundation)] private static extern nint CFArrayGetCount(IntPtr array);
    [DllImport(CoreFoundation)] private static extern IntPtr CFStringCreateWithCString(IntPtr allocator, [MarshalAs(UnmanagedType.LPUTF8Str)] string value, uint encoding);
    [DllImport(CoreFoundation)] private static extern void CFRelease(IntPtr value);
}
