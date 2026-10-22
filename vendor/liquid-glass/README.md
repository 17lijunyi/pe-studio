# Liquid Glass 0.1.0

Vendored from the user-supplied **LiquidGlass-网页复用包** on 2026-10-16.
Package identity: `@vibe/liquid-glass`, version `0.1.0`, MIT.

The upstream JavaScript SHA-256 is
`e38d12e5f17bd8f0421ccc921ac98df36836f09448ae33aab0b22abf429b125b`.
For public distribution, nine developer-machine absolute paths in material
source metadata are replaced with portable research-relative paths; optical
parameters and runtime logic are unchanged. Declarations, license and upstream
validation are copied unchanged; provenance retains upstream metadata and records
this local adaptation. The distributed JavaScript SHA-256 is
`7004ba90efb18ef26ddb9e062ca3aeccb63e652e549665460f67dec490caf795`.

PE Studio's React adapter is in `components/studio/liquid-glass.tsx`. The web
path keeps the supplied Clear material, `variable13` kernel and interaction
springs. Its explicit, application-painted background is a neutral texture;
it does not capture the desktop, other applications, screenshots or arbitrary
DOM content. Desktop windows instead use the public AppKit Clear material on
macOS 26+, with transparent DOM and localized reading backplates. They do not
instantiate this library's opaque canvas over the native backdrop. Older macOS
versions use system vibrancy. Accessibility modes use opaque surfaces.

The upstream `VALIDATION.json` describes the supplied library's checks, not
PE Studio's integration checks. This is a partial reconstruction of a glass
material, not complete native compositor equivalence. See `PROVENANCE.json` for
the supplied limitations and `LICENSE` for redistribution terms.
