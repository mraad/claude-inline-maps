# inline-maps

A Claude Code mod that draws a map right in your terminal. Give it the URL of a map service and the picture shows up inline, with the source and a clickable path below it.

Works with:

| Service | Example URL |
| --- | --- |
| ArcGIS MapServer / ImageServer | `https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer` |
| OGC WMS 1.1.1 / 1.3.0 | `https://ows.terrestris.de/osm/service` |
| OGC API - Maps | `https://example.org/api/collections/roads` (or `.../map`) |
| XYZ / WMTS RESTful tiles | `https://tile.opentopomap.org/{z}/{x}/{y}.png` |

## Use

```
/map <url> [bbox=minx,miny,maxx,maxy] [layers=a,b] [width=800]
```

Or ask Claude: "show me https://…/MapServer". Claude calls the `show_map` tool, which takes the same options.

Both draw the map in the transcript: the tool in its result row, `/map` in its output row.

- `bbox`: degrees, EPSG:4326. Default is the service's full extent.
- `layers`: WMS layer names, or ArcGIS layer ids (shown as `show:ids`). Default is the first named WMS layer / all ArcGIS layers.
- `width`: pixels, 64 to 2000.

## Install

```
claude plugin marketplace add mraad/claude-inline-maps
claude plugin install inline-maps@claude-inline-maps
```

To install it for one project only, run both commands from that project with `--scope project` (written to `.claude/settings.json`).

Requires Claude Code 2.1.287 or newer (mods support) and `curl`. Stitching tiles also needs ImageMagick (`magick`).

## Terminals

Same as [claude-inline-images](https://github.com/kbrianps/claude-inline-images): Ghostty, kitty, and tmux with passthrough draw the map; elsewhere you get the caption and the file path.

## What it does not do

- No tokens or logins: services that need authentication fail with the service's message.
- Tiles: Web Mercator, 256 px, whole tiles (the picture covers the bbox, it is not cropped to it), at most 4×4. WMTS capabilities documents are not read; pass the RESTful template.
- Maps over 2 MiB are drawn from the file path, which needs the terminal to read the file itself (local Ghostty/kitty, not SSH or tmux). Downloads are capped at 4 MiB and 20 s.
- Only PNG is drawn.
- Maps are saved as `map-N.png` in one temp directory (`mktemp -d`) per Claude Code process. Nothing deletes these directories, so they collect in `$TMPDIR` across sessions; stitched tile files are deleted right after stitching.
- Errors (a non-2xx HTTP status, even with a PNG body; `ServiceException`; ArcGIS `error.message`; a non-PNG reply, quoted only when it is text) have no picture. The tool returns them as a tool error; `/map` prints them as text.
- Desktop app, VS Code extension and mobile are left untouched: there, `/map` shows its text (caption, size, path).

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # try it
```

[`docs/index.html`](docs/index.html) explains how the mod works, with sample maps.

The plugin API this mod uses is early access in Claude Code and may change between releases. Tested with Claude Code 2.1.312.

## License

MIT
