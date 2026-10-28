# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sister of `../claude-inline-images`: a Claude Code **mod** (early-access plugin API, 2.1.287+) that draws a map from a service URL via the kitty graphics protocol. No build step; Claude Code loads `hooks/register.tsx` (`hooks/hooks.json`). `claude-code` imports come from the host; `.claude-plugin/types/` is written by the engine on load and gitignored.

## Commands

```
claude plugin validate .
claude plugin test .       # hooks/maps.test.ts (pure planners, canned responses; no fs/network in the test env)
claude --plugin-dir .      # live try-out in a Ghostty/kitty session
```

`claude plugin test` runs every `*.test.ts(x)` and has no name filter (`claude plugin test --help`). Tests import from `claude-code/testing`.

## Architecture

- `hooks/maps.ts`: pure, no host APIs. `plan(input, get)` detects the service type from the URL and returns a `TPlan`: one image URL (ArcGIS `export`/`exportImage`, WMS `GetMap`, OGC API `/map`) or a list of XYZ tile URLs. `get` is injected (text fetch) so tests feed fixtures. Detection order: `{z}`/`{TileMatrix}` template, MapServer/ImageServer, `/collections` or `/map`, `service=wms`|`/wms`, else probe WMS then OGC API.
- `hooks/register.tsx`: host wiring. `session.start` registers the `show_map` tool (`mcp__inline-maps__show_map`, `isDeferred: false`) and `/map`. `tool.call` and `command.run` share `show()` = `plan` → `download`. `download` makes one `mktemp -d` directory per process (memoized promise), fetches with `curl` because `$.http.fetch` is text-only, reads each PNG once (`curl()` returns its base64), and stitches tiles with `magick montage` then `rm`s the tile files. `remember()` caches base64 only when ≤2 MiB. The `ui.render` hook on `ToolResult` draws `Image` + caption + path `Link` from the cache, else from `{ file }` (it never re-reads the file). `/map` returns text only; the picture comes from the tool result.
- Rules: WMS 1.3.0 EPSG:4326 bbox is lat,lon (1.1.1 lon,lat). curl is restricted to http/https (`--proto`, `--proto-redir`), 4 MiB, 20 s. Non-PNG bodies are read as text and surfaced as the error.
- Inputs are defined in four places that must agree: `TInput` (`maps.ts`), the `show_map` `inputSchema` and `parseArgs` for `/map` (`register.tsx`), and the README usage. The README "What it does not do" limits mirror the constants at the top of both files.
- `boxFor`, `pngSize`/`decodeBase64`, `fileUrl` are copies of the helpers in `../claude-inline-images/hooks/register.tsx`; keep them in sync.
