# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sister of `../claude-inline-images`: a Claude Code **mod** (early-access plugin API, 2.1.287+) that draws a map from a service URL via the kitty graphics protocol. No build step; Claude Code loads `hooks/register.tsx` (`hooks/hooks.json`). `claude-code` imports come from the host; `.claude-plugin/types/` is written by the engine on load and gitignored.

## Commands

```
claude plugin validate .
claude plugin test .       # maps.test.ts (planners, canned responses) + register.test.tsx (/map row render); no fs/network in the test env
claude --plugin-dir .      # live try-out in a Ghostty/kitty session
```

`claude plugin test` runs every `*.test.ts(x)` and has no name filter (`claude plugin test --help`). Tests import from `claude-code/testing`.

## Architecture

- `hooks/maps.ts`: pure, no host APIs. `plan(input, get)` detects the service type from the URL and returns a `TPlan`: one image URL (ArcGIS `export`/`exportImage`, WMS `GetMap`, OGC API `/map`) or a list of XYZ tile URLs. `get` is injected (text fetch) so tests feed fixtures. Detection order: `{z}`/`{TileMatrix}` template, MapServer/ImageServer, `/collections` or `/map`, `service=wms`|`/wms`, else probe WMS then OGC API.
- `hooks/register.tsx`: host wiring. `session.start` registers the `show_map` tool (`mcp__inline-maps__show_map`, `isDeferred: false`) and `/map`. `tool.call` and `command.run` share `show()` = `plan` → `download`. `download` makes one `mktemp -d` directory per process (memoized promise), fetches with `curl` because `$.http.fetch` is text-only, reads each PNG once (`curl()` returns its base64), and stitches tiles with `magick montage` then `rm`s the tile files. `remember()` caches base64 only when ≤2 MiB. The tool's result is `TShown` as a JSON string (2.1.312 rejects an object result for a registered tool with "does not match its output shape"); the `ui.render` hook parses it back from `e.props.output` and on `ToolResult` draws `Image` + caption + path `Link` from the cache, else from `{ file }` (it never re-reads the file). `/map` answers text (`<source>: <caption> · <w>×<h>\n<path>`); a second `ui.render` hook on `CommandOutput` parses that text back and draws the same view via `draw()`, so changing that text format breaks the `/map` picture. `hooks/register.test.tsx` mounts that row.
- Rules: WMS 1.3.0 EPSG:4326 bbox is lat,lon (1.1.1 lon,lat). Image size follows the ground, not the degree ratio: ArcGIS keeps square pixels, so a degree extent is drawn with `imageSR=3857` and sized by `mercatorAspect`; WMS and OGC API stretch to the requested size, so they keep EPSG:4326 and are sized by `groundAspect` (cos of mid-latitude). curl is restricted to http/https (`--proto`, `--proto-redir`), 4 MiB, 20 s, and sends an identifying User-Agent (OpenStreetMap tiles are blocked otherwise). A non-2xx status fails even when the body is a PNG (tile servers send error tiles); a non-PNG body is quoted in the error only when its content type is text/xml/json.
- Inputs are defined in four places that must agree: `TInput` (`maps.ts`), the `show_map` `inputSchema` and `parseArgs` for `/map` (`register.tsx`), and the README usage. The README "What it does not do" limits mirror the constants at the top of both files.
- `docs/index.html` is a hand-written overview (STE100 style, no build, no JS) with real outputs in `docs/images/`; update it when behaviour it describes changes.
- `boxFor`, `pngSize`/`decodeBase64`, `fileUrl` are copies of the helpers in `../claude-inline-images/hooks/register.tsx`; keep them in sync.
