import type { EngineInterface, Register, RenderInput } from 'claude-code'

import { markerPixel, plan, type TInput, type TPlan } from './maps'

type TSize = { width: number; height: number }
type TShown = TSize & { path: string; caption: string; source: string }

const TOOL = 'mcp__inline-maps__show_map'
const MAX_COLUMNS = 80
const MAX_ROWS = 30
const MARGIN = 4
const CELL_RATIO = 2
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024
const MAX_INLINE_BYTES = 2 * 1024 * 1024
const CACHE_LIMIT = 12
const CURL_SECONDS = 20
// OpenStreetMap's tile policy blocks generic clients (curl's default) with an error tile sent as HTTP 200.
const USER_AGENT = 'inline-maps (+https://github.com/mraad/claude-inline-maps)'
const FALLBACK_SIZE: TSize = { width: 1600, height: 1000 }

const pictures = new Map<string, string | null>()
let directory: Promise<string> | null = null
let counter = 0

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const decodeBase64 = (text: string) => {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0

  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
}

const pngSize = (base64: string): TSize | null => {
  const header = decodeBase64(base64.slice(0, 44))
  const isSignature = header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
  if (!isSignature) return null

  const view = new DataView(header.buffer)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const fileUrl = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`

const boxFor = ({ width, height }: TSize, maxColumns: number) => {
  let columns = Math.min(maxColumns, Math.max(1, Math.round(width / 10)))
  let rows = Math.max(1, Math.round((columns * height) / width / CELL_RATIO))

  if (rows > MAX_ROWS) {
    rows = MAX_ROWS
    columns = Math.max(1, Math.round((rows * CELL_RATIO * width) / height))
  }

  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}

const remember = (path: string, base64: string) => {
  pictures.delete(path)
  pictures.set(path, (base64.length * 3) / 4 <= MAX_INLINE_BYTES ? base64 : null)
  if (pictures.size > CACHE_LIMIT) {
    const oldest = pictures.keys().next().value
    if (oldest !== undefined) pictures.delete(oldest)
  }
}

const parseArgs = (args: string): TInput | null => {
  const [url, ...rest] = args.trim().split(/\s+/)
  if (!url) return null

  const input: TInput = { url }
  let last = ''
  for (const word of rest) {
    // A marker label may hold spaces: words without "=" after marker= continue it.
    if (last === 'marker' && !word.includes('=')) {
      input.marker += ` ${word}`
      continue
    }
    const [key = '', ...value] = word.split('=')
    const text = value.join('=')
    if (key === 'bbox' || key === 'layers' || key === 'marker') input[key] = text
    else if (key === 'width') input.width = Number(text)
    last = key
  }
  return input
}

const tempDirectory = ($: EngineInterface) => {
  directory ??= $.process.run(['mktemp', '-d', '-t', 'inline-maps']).then(made => {
    if (made.exitCode !== 0) throw new Error(`mktemp failed: ${made.stderr.trim()}`)
    return made.stdout.trim()
  })
  return directory
}

// Downloads one URL to `out`; returns the PNG as base64 or throws with the server's message.
const curl = async ($: EngineInterface, url: string, out: string, accept?: string) => {
  const ran = await $.process.run(
    [
      'curl', '-sSL',
      '--max-time', String(CURL_SECONDS),
      '--max-filesize', String(MAX_DOWNLOAD_BYTES),
      '--proto', '=http,https',
      '--proto-redir', '=http,https',
      '-A', USER_AGENT,
      ...(accept ? ['-H', `Accept: ${accept}`] : []),
      '-o', out,
      '-w', '%{http_code} %{content_type}',
      url,
    ],
    { timeoutMs: (CURL_SECONDS + 5) * 1000 },
  )
  if (ran.exitCode !== 0) throw new Error(`curl failed (${ran.exitCode}): ${ran.stderr.trim() || url}`)

  const [status = '', ...rest] = ran.stdout.trim().split(' ')
  const type = rest.join(' ')
  const ok = status.startsWith('2')
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  if (ok && pngSize(base64)) return base64

  // Servers send error pages as PNG tiles too, so the status decides; only text bodies are worth quoting.
  const text = /text|xml|json/i.test(type) ? await $.fs.read(out) : ''
  const message = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  throw new Error(`HTTP ${status}${ok ? ', not a PNG' : ''} (${type || 'no content type'}): ${message || url}`)
}

// Fetches the plan's image(s) into a temp directory; tiles are stitched into one PNG.
const download = async ($: EngineInterface, request: TPlan): Promise<TShown> => {
  const dir = await tempDirectory($)
  const id = ++counter
  const out = `${dir}/map-${id}.png`
  let base64: string

  if (request.kind === 'image') {
    base64 = await curl($, request.url, out, request.accept)
  } else {
    const files = request.urls.map((_, i) => `${dir}/tile-${id}-${i}.png`)
    await Promise.all(request.urls.map((url, i) => curl($, url, files[i])))
    const joined = await $.process.run([
      'magick', 'montage',
      '-tile', `${request.columns}x${request.rows}`,
      '-geometry', '+0+0',
      ...files,
      out,
    ])
    await $.process.run(['rm', '-f', ...files])
    if (joined.exitCode !== 0) {
      throw new Error(`stitching tiles needs ImageMagick (magick): ${joined.stderr.trim() || 'not found'}`)
    }
    base64 = (await $.fs.read(out, { as: 'bytes' })).base64
  }

  const { marker, frame } = request
  const drawn = pngSize(base64)
  if (marker && frame && drawn) {
    const { x, y } = markerPixel(frame, drawn, marker.lon, marker.lat)
    const [px, py] = [Math.round(x), Math.round(y)]
    // A pin with its tip on the point; numbers only, no text, so no font is needed. The label goes in the caption.
    const pinned = await $.process.run([
      'magick', out,
      '-fill', '#d7263d', '-stroke', 'white', '-strokewidth', '2',
      '-draw', `path 'M ${px},${py} L ${px - 11},${py - 24} A 12,12 0 1,1 ${px + 11},${py - 24} Z'`,
      '-fill', 'white', '-stroke', 'none',
      '-draw', `circle ${px},${py - 29} ${px + 4},${py - 29}`,
      out,
    ])
    if (pinned.exitCode !== 0) {
      throw new Error(`drawing the marker needs ImageMagick (magick): ${pinned.stderr.trim() || 'not found'}`)
    }
    base64 = (await $.fs.read(out, { as: 'bytes' })).base64
  }

  remember(out, base64)
  const size = pngSize(base64) ?? FALLBACK_SIZE
  return { ...size, path: out, caption: request.caption, source: request.source }
}

const show = async ($: EngineInterface, input: TInput) => {
  const request = await plan(input, async url => {
    const response = await $.http.fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
    return response.text
  })
  return download($, request)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_map',
      description:
        'Draws a map inline in the user\'s terminal from a map service URL: ArcGIS MapServer/ImageServer, OGC WMS, OGC API - Maps, or an XYZ/WMTS tile template with {z}/{x}/{y}. Use when the user wants to see a map.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Service URL (http/https), or a tile template with {z}/{x}/{y}' },
          bbox: { type: 'string', description: 'Optional minx,miny,maxx,maxy in degrees (EPSG:4326)' },
          layers: { type: 'string', description: 'Optional layer name(s): WMS layers, or ArcGIS layer ids' },
          width: { type: 'number', description: 'Optional image width in pixels (default 800)' },
          marker: { type: 'string', description: 'Optional pin: lon,lat or lon,lat,label in degrees (EPSG:4326); the label is shown in the caption' },
        },
        required: ['url'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'map',
      description: 'Draw a map service inline',
      argumentHint: '<url> [bbox=minx,miny,maxx,maxy] [layers=a,b] [width=800] [marker=lon,lat,label]',
    })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    try {
      const shown = await show($, e as unknown as TInput)
      // A registered tool's result must be a string (or content blocks); ui.render parses it back.
      return { result: JSON.stringify(shown) }
    } catch (error) {
      return { deny: `map failed: ${(error as Error).message}` }
    }
  }).catch(() => ({ deny: 'map tool failed' }))

  on('command.run', { command: 'map' }, async ($, e) => {
    const input = parseArgs(e.args)
    if (!input) return { text: 'Usage: /map <url> [bbox=minx,miny,maxx,maxy] [layers=a,b] [width=800] [marker=lon,lat,label]' }

    try {
      const shown = await show($, input)
      return { text: `${shown.source}: ${shown.caption} · ${shown.width}×${shown.height}\n${shown.path}` }
    } catch (error) {
      return { text: `map failed: ${(error as Error).message}` }
    }
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== TOOL || e.props.isErrored) return next(e)

    let shown: Partial<TShown> | undefined
    try {
      shown = typeof e.props.output === 'string' ? JSON.parse(e.props.output) : undefined
    } catch {
      return next(e)
    }
    if (!shown?.path) return next(e)
    return draw($, e, shown as TShown)
  })

  // Reads back the text /map answered: "<source>: <caption> · <w>×<h>\n<path>".
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.command !== 'map' || e.props.isErrored) return next(e)

    const match = /^(?:inline-maps: )?(.+?): (.+) · (\d+)×(\d+)\n(\/\S+\.png)$/.exec(e.props.text.trim())
    if (!match) return next(e)
    const [, source = '', caption = '', width, height, path = ''] = match
    return draw($, e, { source, caption, width: Number(width), height: Number(height), path })
  })
}

const draw = ($: EngineInterface, e: RenderInput<'ToolResult' | 'CommandOutput', 'terminal'>, shown: TShown) => {
  const png = pictures.get(shown.path)
  const maxColumns = Math.max(10, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? Infinity) - MARGIN))
  const box = boxFor(shown.width && shown.height ? { width: shown.width, height: shown.height } : FALLBACK_SIZE, maxColumns)
  const { Box, Text, Image, Link } = $.ui.resolve(e)

  return (
    <Box flexDirection="column" gap={1} marginTop={1} marginBottom={1}>
      <Text dimColor>
        {shown.source} · {shown.caption}
      </Text>
      <Image
        source={png ? { png } : { file: shown.path, format: 'png', generation: shown.width }}
        columns={box.columns}
        rows={box.rows}
        alt={`[map] ${shown.caption}`}
      />
      <Text dimColor>
        <Link href={fileUrl(shown.path)} label={shown.path} />
      </Text>
    </Box>
  )
}
