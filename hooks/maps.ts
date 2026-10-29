type TBbox = [number, number, number, number] // minx, miny, maxx, maxy in EPSG:4326
export type TInput = { url: string; bbox?: string; layers?: string; width?: number }
type TText = (url: string) => Promise<string>

// What to download: one image URL, or XYZ tiles to stitch into a grid.
export type TPlan =
  | { kind: 'image'; source: string; url: string; accept?: string; caption: string }
  | { kind: 'tiles'; source: string; urls: string[]; columns: number; rows: number; caption: string }

const DEFAULT_WIDTH = 800
const MAX_WIDTH = 2000
const MAX_TILES_PER_SIDE = 4
const MAX_ZOOM = 18
const WORLD: TBbox = [-180, -85, 180, 85]

export const parseBbox = (text?: string): TBbox | null => {
  if (!text) return null
  const parts = text.split(',').map(part => Number(part.trim()))
  const [minx, miny, maxx, maxy] = parts
  const isValid =
    parts.length === 4 &&
    parts.every(Number.isFinite) &&
    minx < maxx &&
    miny < maxy &&
    Math.abs(minx) <= 180 &&
    Math.abs(maxx) <= 180 &&
    Math.abs(miny) <= 90 &&
    Math.abs(maxy) <= 90
  return isValid ? [minx, miny, maxx, maxy] : null
}

const sizeFor = (aspect: number, requested = DEFAULT_WIDTH) => {
  const width = Math.min(MAX_WIDTH, Math.max(64, Math.round(requested)))
  const height = Math.min(MAX_WIDTH, Math.max(64, Math.round(width / aspect)))
  return { width, height }
}

const RAD = Math.PI / 180

// Width/height of a degree box on the ground: a degree of longitude shrinks by cos(latitude).
// WMS and OGC API stretch the image to the requested size, so this keeps shapes true near mid-latitude.
const groundAspect = ([minx, miny, maxx, maxy]: TBbox) =>
  ((maxx - minx) * Math.cos(((miny + maxy) / 2) * RAD)) / (maxy - miny)

// Width/height of a degree box in Web Mercator (what ArcGIS draws with imageSR=3857).
const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.0511, Math.min(85.0511, lat)) * RAD) / 2))
const mercatorAspect = ([minx, miny, maxx, maxy]: TBbox) => ((maxx - minx) * RAD) / (mercatorY(maxy) - mercatorY(miny))

const num = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} is not a number: ${value}`)
  return parsed
}

const query = (params: Record<string, string | number>) =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')

const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<(?:\\w+:)?${name}>\\s*([^<]*?)\\s*</`))?.[1]

const serviceError = (text: string) => {
  const exception = text.match(/<(?:\w+:)?ServiceException\b[^>]*>([\s\S]*?)<\/(?:\w+:)?ServiceException>/)
  if (exception) return exception[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()
  try {
    const message = JSON.parse(text)?.error?.message
    return typeof message === 'string' ? message : null
  } catch {
    return null
  }
}

const getJson = async (get: TText, url: string) => {
  const text = await get(url)
  const error = serviceError(text)
  if (error) throw new Error(error)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`not JSON: ${url}`)
  }
}

// ArcGIS REST: .../MapServer/export or .../ImageServer/exportImage.
const arcgis = async (input: TInput, bbox: TBbox | null, get: TText): Promise<TPlan> => {
  const match = input.url.match(/^(.*?\/(?:MapServer|ImageServer))/i)
  if (!match) throw new Error('not an ArcGIS MapServer or ImageServer URL')
  const [, base] = match
  const isImage = /ImageServer$/i.test(base)

  const info = await getJson(get, `${base}?f=json`)
  const extent = bbox
    ? { xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3], sr: 4326 }
    : (() => {
        const full = info.fullExtent ?? info.extent
        if (!full) throw new Error('service reports no extent; pass bbox')
        const sr = full.spatialReference?.latestWkid ?? full.spatialReference?.wkid
        if (!sr) throw new Error('service extent has no spatial reference; pass bbox')
        return { xmin: full.xmin, ymin: full.ymin, xmax: full.xmax, ymax: full.ymax, sr }
      })()

  // ArcGIS keeps square pixels, so a degree extent drawn in EPSG:4326 comes out stretched east-west; draw it in Web Mercator.
  const box: TBbox = [extent.xmin, extent.ymin, extent.xmax, extent.ymax]
  const isDegrees = extent.sr === 4326
  const imageSR = isDegrees ? 3857 : extent.sr
  const { width, height } = sizeFor(isDegrees ? mercatorAspect(box) : (box[2] - box[0]) / (box[3] - box[1]), input.width)
  const params: Record<string, string | number> = {
    bbox: box.join(','),
    bboxSR: extent.sr,
    imageSR,
    size: `${width},${height}`,
    format: isImage ? 'png' : 'png32',
    f: 'image',
  }
  if (input.layers && !isImage) params.layers = `show:${input.layers}`

  const name = typeof info.mapName === 'string' ? info.mapName : typeof info.name === 'string' ? info.name : base.split('/').slice(-2, -1)[0]
  return {
    kind: 'image',
    source: isImage ? 'ArcGIS ImageServer' : 'ArcGIS MapServer',
    url: `${base}/${isImage ? 'exportImage' : 'export'}?${query(params)}`,
    caption: `${name} · EPSG:${imageSR}`,
  }
}

// OGC WMS 1.1.1 / 1.3.0 GetMap; layer and bbox come from GetCapabilities.
const wms = async (input: TInput, bbox: TBbox | null, get: TText): Promise<TPlan> => {
  const [base, search = ''] = input.url.split('?')
  const keep = search
    .split('&')
    .filter(pair => pair && !/^(service|request|version|layers|styles|format|width|height|bbox|crs|srs)=/i.test(pair))
  const url = (params: Record<string, string | number>) =>
    `${base}?${[...keep, query(params)].join('&')}`

  const caps = await get(url({ service: 'WMS', request: 'GetCapabilities' }))
  const error = serviceError(caps)
  if (error) throw new Error(error)
  if (!/<(?:\w+:)?(?:WMS_Capabilities|WMT_MS_Capabilities)/.test(caps)) {
    throw new Error('GetCapabilities did not return WMS capabilities')
  }

  const version = caps.match(/<(?:\w+:)?(?:WMS_Capabilities|WMT_MS_Capabilities)[^>]*\bversion="([^"]+)"/)?.[1] ?? '1.1.1'
  const layer = input.layers ?? caps.match(/<(?:\w+:)?Layer\b[^>]*>(?:(?!<\/(?:\w+:)?Layer>)[\s\S])*?<(?:\w+:)?Name>\s*([^<]+?)\s*<\//)?.[1]
  if (!layer) throw new Error('WMS lists no named layer; pass layers')

  let area = bbox
  if (!area) {
    const west = tag(caps, 'westBoundLongitude')
    const box = west
      ? [west, tag(caps, 'southBoundLatitude'), tag(caps, 'eastBoundLongitude'), tag(caps, 'northBoundLatitude')]
      : (['minx', 'miny', 'maxx', 'maxy'] as const).map(
          key => caps.match(new RegExp(`<(?:\\w+:)?LatLonBoundingBox[^>]*\\b${key}="([^"]+)"`))?.[1],
        )
    area = box.every(Boolean) ? (box.map((value, i) => num(value!, `bbox[${i}]`)) as TBbox) : WORLD
  }

  const { width, height } = sizeFor(groundAspect(area), input.width)
  const isNew = version.startsWith('1.3')
  // 1.3.0 axis order for EPSG:4326 is lat,lon; 1.1.1 is lon,lat.
  const box = isNew ? [area[1], area[0], area[3], area[2]] : area
  return {
    kind: 'image',
    source: 'OGC WMS',
    url: url({
      service: 'WMS',
      request: 'GetMap',
      version: isNew ? '1.3.0' : '1.1.1',
      layers: layer,
      styles: '',
      format: 'image/png',
      width,
      height,
      [isNew ? 'crs' : 'srs']: 'EPSG:4326',
      bbox: box.join(','),
    }).replace(/%2C/g, ','),
    caption: `${layer} · WMS ${version}`,
  }
}

// OGC API - Maps: .../collections/{id}/map (or a landing/collection page that links to it).
const ogcApi = async (input: TInput, bbox: TBbox | null, get: TText): Promise<TPlan> => {
  const clean = input.url.split('?')[0].replace(/\/$/, '')
  let map = /\/map$/.test(clean) ? clean : null

  if (!map) {
    const doc = await getJson(get, `${clean}?f=json`)
    const link = (doc.links ?? []).find(
      (one: { rel?: string; href?: string }) => one.href && /\/map$|ogc\/1\.0\/map\b|^map$/.test(one.rel ?? ''),
    )
    if (link) map = new URL(link.href, `${clean}/`).href.split('?')[0]
    else if (/\/collections\/[^/]+$/.test(clean)) map = `${clean}/map`
    else throw new Error('no OGC API - Maps link found; pass a collection or .../map URL')
  }

  const area = bbox ?? WORLD
  const { width, height } = sizeFor(groundAspect(area), input.width)
  const params: Record<string, string | number> = { width, height, f: 'png' }
  if (bbox) params.bbox = bbox.join(',')
  return {
    kind: 'image',
    source: 'OGC API - Maps',
    url: `${map}?${query(params).replace(/%2C/g, ',')}`,
    accept: 'image/png',
    caption: map.replace(/^https?:\/\//, ''),
  }
}

const clamp = (index: number, z: number) => Math.min(2 ** z - 1, Math.max(0, Math.floor(index)))
const tileX = (lon: number, z: number) => clamp(((lon + 180) / 360) * 2 ** z, z)
const tileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180
  return clamp(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z, z)
}

// XYZ / WMTS RESTful template. shortcut: Web Mercator 256px tiles, whole tiles (no crop to bbox); WMTS capabilities are not read.
const tiles = (input: TInput, bbox: TBbox | null): TPlan => {
  const template = decodeURIComponent(input.url)
  const area = bbox ?? WORLD

  const span = (z: number) => {
    const x0 = tileX(area[0], z)
    const y0 = tileY(area[3], z)
    return { x0, y0, columns: tileX(area[2], z) - x0 + 1, rows: tileY(area[1], z) - y0 + 1 }
  }

  let z = 0
  for (let next = 1; next <= MAX_ZOOM; next++) {
    const { columns, rows } = span(next)
    if (columns > MAX_TILES_PER_SIDE || rows > MAX_TILES_PER_SIDE) break
    z = next
  }
  const { x0, y0, columns, rows } = span(z)

  const urls: string[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      urls.push(
        template
          .replace(/\{(?:z|TileMatrix)\}/g, String(z))
          .replace(/\{(?:x|TileCol)\}/g, String(x0 + column))
          .replace(/\{(?:y|TileRow)\}/g, String(y0 + row))
          .replace(/\{-y\}/g, String(2 ** z - 1 - (y0 + row)))
          .replace(/\{s\}/g, 'a')
          .replace(/\{r\}/g, ''),
      )
    }
  }
  return { kind: 'tiles', source: 'XYZ tiles', urls, columns, rows, caption: `zoom ${z} · ${columns}×${rows} tiles` }
}

const isTemplate = (url: string) => /\{(?:z|TileMatrix)\}/.test(decodeURIComponent(url))

export const plan = async (input: TInput, get: TText): Promise<TPlan> => {
  if (!/^https?:\/\//i.test(input.url)) throw new Error('url must start with http:// or https://')

  const bbox = parseBbox(input.bbox)
  if (input.bbox && !bbox) throw new Error('bbox must be minx,miny,maxx,maxy in degrees (EPSG:4326)')

  if (isTemplate(input.url)) return tiles(input, bbox)
  if (/\/(?:MapServer|ImageServer)\b/i.test(input.url)) return arcgis(input, bbox, get)
  if (/\/collections\b|\/map\/?(?:\?|$)/i.test(input.url)) return ogcApi(input, bbox, get)
  if (/service=wms\b|\/wms\b/i.test(input.url)) return wms(input, bbox, get)

  // Unrecognised path (e.g. .../osm/service): WMS endpoints answer GetCapabilities, OGC API landing pages answer JSON.
  try {
    return await wms(input, bbox, get)
  } catch (wmsError) {
    try {
      return await ogcApi(input, bbox, get)
    } catch {
      throw wmsError
    }
  }
}
