# Erebus icon assets

`erebus-icon.png` is the canonical high-resolution artwork. `erebus-glyph-source.png` is the transparent monolith used for small desktop and interface marks. Generated desktop and web files live in the `dev`, `nightly`, and `prod` folders.

The source contains soft gradients, facet shading, and a cast shadow. Keep the raster source for exact visual fidelity. Do not replace it with an approximate vector trace.

The release build uses:

- `prod/erebus-windows.ico` for Windows
- `prod/erebus-macos-1024.png` for macOS packaging
- `prod/erebus-universal-1024.png` for Linux packaging
- `prod/erebus-web-*` for web and splash assets

Run `pnpm brand:icons` after changing the transparent glyph. The exporter removes detached pixels, creates the dark and ice-white interface marks, preserves the source artwork for the desktop mark, and writes anti-aliased multi-size Windows and web icons.
