# inline-maps

A Claude Code mod that draws a map right in your terminal. Give it the URL of a map service and the picture shows up inline, with the source and a clickable path below it.

Works with:

| Service | Example URL |
| --- | --- |
| ArcGIS MapServer / ImageServer | `https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer` |
| OGC WMS 1.1.1 / 1.3.0 | `https://ows.terrestris.de/osm/service` |
| OGC API - Maps | `https://example.org/api/collections/roads` (or `.../map`) |
| XYZ / WMTS RESTful tiles | `https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png` |

## Use

```
/map <url> [bbox=minx,miny,maxx,maxy] [layers=a,b] [width=800]
```

Or ask Claude: "show me https://…/MapServer". Claude calls the `show_map` tool, which takes the same options.

- `bbox`: degrees, EPSG:4326. Default is the service's full extent.
- `layers`: WMS layer names, or ArcGIS layer ids (shown as `show:ids`). Default is the first named WMS layer / all ArcGIS layers.
- `width`: pixels, 64 to 2000.

## Install

```
claude plugin install inline-maps --marketplace mraad/claude-inline-maps
```

Requires Claude Code 2.1.287 or newer (mods support) and `curl`. Stitching tiles also needs ImageMagick (`magick`).

## Terminals

Same as [claude-inline-images](https://github.com/kbrianps/claude-inline-images): Ghostty, kitty, and tmux with passthrough draw the map; elsewhere you get the caption and the file path.

## What it does not do

- No tokens or logins: services that need authentication fail with the service's message.
- Tiles: Web Mercator, 256 px, whole tiles (the picture covers the bbox, it is not cropped to it), at most 4×4. WMTS capabilities documents are not read; pass the RESTful template.
- Maps over 2 MiB are drawn from the file path, which needs the terminal to read the file itself (local Ghostty/kitty, not SSH or tmux). Downloads are capped at 4 MiB and 20 s.
- Only PNG is drawn.
- Maps are saved as `map-N.png` in a temp directory (`mktemp -d`) that is not cleaned up during the session; stitched tile files are deleted right after stitching.
- Errors (HTTP status, `ServiceException`, ArcGIS `error.message`, a non-PNG reply) come back as the tool result text, with no picture.
- Desktop app, VS Code extension and mobile are left untouched.
- The `/map` command prints the caption and path as text. Whether Claude Code draws a plugin command's tool result is untested; use the tool (ask Claude) for the picture.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # try it
```

The plugin API this mod uses is early access in Claude Code and may change between releases. Tested with Claude Code 2.1.312.

## License

MIT
