# Kinocut 1.11.1 Windows compatibility note

The isolated runtime pins:

- `kinocut==1.11.1`
- `mcp==1.27.0`

Two upstream compatibility issues were encountered:

1. Kinocut permits `mcp>=1.27.0`, which currently resolves to `mcp 2.0`.
   Kinocut 1.11.1 still imports `mcp.server.fastmcp`, so this demo pins the
   compatible 1.27 release.
2. Authored ASS burn-in used the generic filter-value escape helper for an
   absolute Windows path. FFmpeg then parsed the drive/path as subtitle filter
   options. The isolated runtime normalizes the temporary ASS path to forward
   slashes, escapes the drive colon, and wraps it as:

   ```text
   subtitles=filename='C\:/path/to/file.ass'
   ```

The patch is scoped to `.runtime/kinocut` and does not modify the system Python
installation.
