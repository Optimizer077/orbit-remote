using System.Security.Cryptography;
using System.Text;
using Org.BouncyCastle.Crypto.Agreement.Srp;
using Org.BouncyCastle.Security;
using Orbit.Host;
using BigInteger = Org.BouncyCastle.Math.BigInteger;

/// <summary>
/// EXPERIMENTAL F33 cross-check vectors. The expected values were derived by an
/// independent Python (hashlib/hmac) implementation of the docs/PROTOCOL.md layout
/// and the RFC 5054 SRP-6a conventions Bouncy Castle 2.7.0 uses (k = H(N|PAD(g)),
/// u = H(PAD(A)|PAD(B)), x = H(s|H(I|":"|P)), M1 = H(PAD(A)|PAD(B)|PAD(S)),
/// M2 = H(PAD(A)|PAD(M1)|PAD(S)), K = H(PAD(S)), PAD = 384 bytes). The private
/// SRP exponents below are fixed fixture values only; production uses SecureRandom.
/// </summary>
public static class ShortPairVectors
{
    internal const string Code = "K7QF2M9X";
    internal const long ExpiresAt = 1798761600; // 2027-01-01T00:00:00Z
    internal const string VerifierSha256 = "F10AC70E4B8FDB2D34EB5513FBB5D133130716C1CFF7925E88D8C70C568DB30E";
    internal const string ASha256 = "7F03C7C69567E4CFD421FFECF9E7EACFB0BA31682B66736D3EB58133C8B76ECE";
    internal const string BSha256 = "88686A30A003180D283B374E6D46D2254E2E118A3F664F94EA45AAC1B1DFC2AF";
    internal const string M1 = "C6974F97BD1297F96C35796F0076EAF84D3CBC65B86B870300CAEDA81261F3CF";
    internal const string M2 = "0DADBA0D23932693BDF6044D52F3AECFE214A7E3BD71739777299956DD6443F4";
    internal const string SessionKey = "8182B8E974FCA7D795E59D497D55A1BF3B7CEF92400E56FAA7C1EE39891578C3";
    // Fields: tag(1) role(1) length(uint16 BE) value. Roles: 00 shared, 01 host, 02 viewer.
    internal const string Transcript =
        "010000106F726269742D73686F72742D70616972" + // tag 01 role 00: protocol (16)
        "020000020001" + // tag 02 role 00: version 1 (2)
        "0300002553525036612D524643353035342D333037322D5348413235362F484D41432D534841323536" + // tag 03 role 00: suite (37)
        "04010010000102030405060708090A0B0C0D0E0F" + // tag 04 role 01: instance id (16)
        "05010010101112131415161718191A1B1C1D1E1F" + // tag 05 role 01: attempt id (16)
        "06020020202122232425262728292A2B2C2D2E2F303132333435363738393A3B3C3D3E3F" + // tag 06 role 02: viewer nonce (32)
        "06010020404142434445464748494A4B4C4D4E4F505152535455565758595A5B5C5D5E5F" + // tag 06 role 01: host nonce (32)
        "07010008000000006B36EC80" + // tag 07 role 01: expiry int64 BE (8)
        "0801000103" + // tag 08 role 01: grants view|control (1)
        "09010020808182838485868788898A8B8C8D8E8F909192939495969798999A9B9C9D9E9F" + // tag 09 role 01: salt (32)
        "0A020180BC0E7CF5DC3BABF67DCEDBB3B140AACC6CAC43F4336B43BBD5DE48D6EA7C8EDA66924E354255225BCCAD9DEBE21182E6BB050F3FF3E6CFBB62C229379968C70CA436AD649A0B051373184215EEF046F6F1F2256838F958581F6C7B2B85FA4AFE326A0E8A951D4489305331AFF88A136FD8D108BCC95FCEB7E557C889C828BD23FB0702F053E1CA6470FB3C76BCE4843FC005C7EA675740F8550212656CFC8919D9DB805A434A68229E0D9DFE43FC16DC680A5CE74B77CF374353B05759BC1DA3A9DABDE30A4209381C87CA83D9483ABDF66B86F9B1CBDA9AD82C62712B87CE6FB7069B8FC8DF344261821A06D0DC5106AF76D4245F3F7737A94DBC484B415555DC401842D3011204553BA9F611B02BC38DE26EBA1A76BF8350205A62C436BA1C3C7C69D59318BD107FD1C1F5D846B3142E85A5D49E522655E020ED1BFE1E186CF923BF328F0B9B4C6A8AA3266ED9125BB98D63827110713BE7803122EE4603C54EA31863CE4B10AFF31F9073CF63B94733B4F066E72D4EC35687047D5D0DB160" + // tag 0A role 02: SRP A (384)
        "0A010180C53998E43825803F342EF9E1D2BCDF2C3C0C528003F6D70CF1C7DD3FDD2F8F899C350A9D5EC647F3DFCD194C854EE0902037813E24F31CFB03AB3631E45698E33824A8F9E1BB3FBA1ADC5DD1116AFB17BDCA1F4C4317740C81F441F152D0031C3477A34C63548EA185689A6D47EFE1CF70538A6AA2BC475AB1626137FA6012B361853E711B9F36CB8323882556AF4358850096F606B4FF1558734DE7158BE5FD6DEFF216D3349517C48292C4467FA7D8B0DC041802C554DC101919234840CE20881E7E1259F08CC3DF55DD6C6364790DB73FC58B3830528127034FD4E5769460304AAEB0F26BD09962013406D6753613F1EBB26093DB06F4F881E9DE5F63A0E579949B86B9C909BA39BC419534C2573A3B5CB3AC68302750A4BF0DAF563FB5C25D140DD0C9B4207805102334DC71661D13D840AB3A7F8607943AB52354C09088428E4E8A001B04EE1F946C90760F476C5F19EF5FF3924037BCB6297A18E48D1171098B87C8D991D4CB0EFFA1B68F566C2C4A9827BED4808D4E8880C9208C5E17" + // tag 0A role 01: SRP B (384)
        "0B010020A0A1A2A3A4A5A6A7A8A9AAABACADAEAFB0B1B2B3B4B5B6B7B8B9BABBBCBDBEBF" + // tag 0B role 01: host certificate SHA-256 (32)
        "0B020020C0C1C2C3C4C5C6C7C8C9CACBCCCDCECFD0D1D2D3D4D5D6D7D8D9DADBDCDDDEDF"; // tag 0B role 02: viewer certificate SHA-256 (32)
    internal const string TranscriptSha256 = "E2F6626DB978D690C5DBAB2078D8AE4CB4BBE4F8B1DA8D918C3493D8A6406557";
    internal const string HostConfirmation = "2886BD3480F67AD73E6BE1429E78299166736D946513186A746A3365C4AD9043";
    internal const string ViewerConfirmation = "192292B0E0B4DA56BE1FE7BE930E805DE926D955C824CA6EEE8CF43EFC4E0286";
    // Same inputs with the final viewer-certificate byte changed (0xDF -> 0xDE): a different certificate.
    internal const string ViewerConfirmationChangedViewerCertificate = "B3774788AB4ACB838FEB75092DB556A4EDBBE42206631FF288755511CB01DCC0";
    // Same inputs with the last byte of the A field flipped: a different SRP public value.
    internal const string ViewerConfirmationChangedA = "A6620CC7A1EF0B416274FE914492AC0D4A91BA740563FE5D9D532F910ABBFB1D";

    public static void Run(Action<bool, string> check)
    {
        check(ShortCode.Encode(new byte[5]) == "00000000" && ShortCode.Encode([0xFF, 0xFF, 0xFF, 0xFF, 0xFF]) == "ZZZZZZZZ"
            && ShortCode.Encode([0x08, 0x42, 0x10, 0x84, 0x21]) == "11111111", "F33 vector: five bytes map to eight 5-bit Crockford symbols, big-endian");

        var salt = Range(0x80, ShortPairProtocol.SaltBytes);
        var verifier = ShortPairProtocol.Verifier(salt, Code);
        check(Hex(SHA256.HashData(ShortPairProtocol.Unsigned(verifier, ShortPairProtocol.GroupBytes))) == VerifierSha256, "F33 vector: SRP verifier for the fixed salt, identity and code");
        var client = new FixedClient(new BigInteger(1, Range(0x01, 32)));
        client.Init(ShortPairProtocol.Group, ShortPairProtocol.Digest(), new SecureRandom());
        var server = new FixedServer(new BigInteger(1, Range(0x21, 32)));
        server.Init(ShortPairProtocol.Group, verifier, ShortPairProtocol.Digest(), new SecureRandom());
        var a = ShortPairProtocol.Unsigned(client.GenerateClientCredentials(salt, ShortPairProtocol.Identity(), Encoding.ASCII.GetBytes(Code)), 384);
        var b = ShortPairProtocol.Unsigned(server.GenerateServerCredentials(), 384);
        check(Hex(SHA256.HashData(a)) == ASha256 && Hex(SHA256.HashData(b)) == BSha256 && ShortPairProtocol.IsCanonicalElement(a) && ShortPairProtocol.IsCanonicalElement(b),
            "F33 vector: SRP public values A and B for fixed fixture exponents");
        client.CalculateSecret(new BigInteger(1, b)); server.CalculateSecret(new BigInteger(1, a));
        var m1 = client.CalculateClientEvidenceMessage();
        check(Hex(ShortPairProtocol.Unsigned(m1, 32)) == M1 && server.VerifyClientEvidenceMessage(m1), "F33 vector: client evidence M1 matches the independent value and verifies");
        var m2 = server.CalculateServerEvidenceMessage();
        check(Hex(ShortPairProtocol.Unsigned(m2, 32)) == M2 && client.VerifyServerEvidenceMessage(m2), "F33 vector: server evidence M2 matches the independent value and verifies");
        var clientKey = ShortPairProtocol.Unsigned(client.CalculateSessionKey(), 32);
        var serverKey = ShortPairProtocol.Unsigned(server.CalculateSessionKey(), 32);
        check(Hex(clientKey) == SessionKey && Hex(serverKey) == SessionKey, "F33 vector: both roles derive K = H(PAD(S))");

        var transcript = ShortPairProtocol.Transcript(new(Range(0x00, 16), Range(0x10, 16), Range(0x20, 32), Range(0x40, 32), ExpiresAt,
            new DevicePermissions(View: true, Control: true), salt, a, b, Range(0xA0, 32), Range(0xC0, 32)));
        check(transcript.Length == 1080 && Hex(transcript) == Transcript && Hex(SHA256.HashData(transcript)) == TranscriptSha256,
            "F33 vector: exact canonical role-tagged, length-delimited transcript bytes (including attempt id, salt, A and B)");
        check(Hex(ShortPairProtocol.Confirmation(clientKey, hostToViewer: true, transcript)) == HostConfirmation, "F33 vector: host-to-viewer confirmation MAC");
        check(Hex(ShortPairProtocol.Confirmation(clientKey, hostToViewer: false, transcript)) == ViewerConfirmation, "F33 vector: viewer-to-host confirmation MAC");
        var changed = transcript.ToArray(); changed[^1] ^= 1;
        check(Hex(ShortPairProtocol.Confirmation(clientKey, hostToViewer: false, changed)) == ViewerConfirmationChangedViewerCertificate,
            "F33 vector: a changed viewer certificate changes the viewer confirmation");
        // The A field header starts at byte 232 (after fields 1-10); its value is bytes 236-619.
        check(transcript.Length > 619 && Hex(transcript[232..236]) == "0A020180", "F33 vector: the A field sits at its documented offset");
        var changedA = transcript.ToArray(); if (changedA.Length > 619) changedA[619] ^= 1;
        check(Hex(ShortPairProtocol.Confirmation(clientKey, hostToViewer: false, changedA)) == ViewerConfirmationChangedA,
            "F33 vector: a changed SRP public value changes the viewer confirmation");
        check(HostConfirmation != ViewerConfirmation, "F33 vector: direction labels make reflected confirmations differ");
    }

    internal static byte[] Range(int start, int count) => Enumerable.Range(start, count).Select(value => (byte)value).ToArray();
    private static string Hex(byte[] value) => Convert.ToHexString(value);

    private sealed class FixedClient(BigInteger value) : Srp6Client
    {
        protected override BigInteger SelectPrivateValue() => value;
    }
    private sealed class FixedServer(BigInteger value) : Srp6Server
    {
        protected override BigInteger SelectPrivateValue() => value;
    }
}
