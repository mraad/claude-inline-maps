import { expect, test } from 'claude-code/testing'

import { markerPixel, parseBbox, parseMarkers, plan, sizeFor, type TInput, type TPlan } from './maps'

const never = async (url: string): Promise<string> => {
  throw new Error(`unexpected fetch: ${url}`)
}

const serving = (pages: Record<string, string>) => async (url: string) => {
  const hit = Object.keys(pages).find(key => url.startsWith(key))
  if (hit === undefined) throw new Error(`unexpected fetch: ${url}`)
  return pages[hit]
}

const image = (result: TPlan) => {
  if (result.kind !== 'image') throw new Error('expected an image plan')
  return result
}

const WMS_130 = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><Name>WMS</Name><Title>Demo</Title></Service>
  <Capability><Layer>
    <Title>Root</Title>
    <Layer><Name>roads</Name><EX_GeographicBoundingBox>
      <westBoundLongitude>-10</westBoundLongitude><eastBoundLongitude>10</eastBoundLongitude>
      <southBoundLatitude>40</southBoundLatitude><northBoundLatitude>50</northBoundLatitude>
    </EX_GeographicBoundingBox></Layer>
  </Layer></Capability>
</WMS_Capabilities>`

const WMS_111 = `<WMT_MS_Capabilities version="1.1.1"><Capability><Layer><Name>topp:states</Name>
  <LatLonBoundingBox minx="-124" miny="24" maxx="-66" maxy="50"/></Layer></Capability></WMT_MS_Capabilities>`

test('parseBbox accepts degrees and rejects the rest', () => {
  expect(parseBbox('-10,40,10,50')).toEqual([-10, 40, 10, 50])
  expect(parseBbox(undefined)).toBeNull()
  expect(parseBbox('10,40,-10,50')).toBeNull()
  expect(parseBbox('1,2,3')).toBeNull()
  expect(parseBbox('0,0,500000,500000')).toBeNull()
})

test('ArcGIS MapServer builds an export URL from the full extent', async () => {
  const info = JSON.stringify({
    mapName: 'Layers',
    fullExtent: { xmin: -100, ymin: 30, xmax: -90, ymax: 40, spatialReference: { wkid: 4326 } },
  })
  const result = image(
    await plan(
      { url: 'https://x.test/arcgis/rest/services/USA/MapServer/0?f=html', layers: '0,2' },
      serving({ 'https://x.test/arcgis/rest/services/USA/MapServer?f=json': info }),
    ),
  )

  expect(result.source).toBe('ArcGIS MapServer')
  expect(result.url).toStartWith('https://x.test/arcgis/rest/services/USA/MapServer/export?')
  expect(result.url).toContain('bbox=-100%2C30%2C-90%2C40')
  // A degree extent is drawn in Web Mercator: 10° of longitude at 30–40°N is taller than wide there.
  expect(result.url).toContain('imageSR=3857')
  expect(result.url).toContain('size=800%2C979')
  expect(result.caption).toBe('Layers · EPSG:3857')
  expect(result.url).toContain('layers=show%3A0%2C2')
  expect(result.url).toContain('f=image')
})

test('ArcGIS ImageServer uses exportImage, and a service error is surfaced', async () => {
  const info = JSON.stringify({ extent: { xmin: 0, ymin: 0, xmax: 20, ymax: 10, spatialReference: { latestWkid: 3857 } } })
  const result = image(
    await plan({ url: 'https://x.test/rest/services/Dem/ImageServer' }, serving({ 'https://x.test/rest/services/Dem/ImageServer?f=json': info })),
  )
  expect(result.url).toContain('/ImageServer/exportImage?')
  expect(result.url).toContain('size=800%2C400')

  const failing = serving({ 'https://x.test/': JSON.stringify({ error: { code: 499, message: 'Token Required' } }) })
  let message = ''
  try {
    await plan({ url: 'https://x.test/rest/services/A/MapServer' }, failing)
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toBe('Token Required')
})

test('WMS 1.3.0 flips the EPSG:4326 axis order', async () => {
  const result = image(
    await plan({ url: 'https://x.test/wms?map=a.map' }, serving({ 'https://x.test/wms?map=a.map&service=WMS': WMS_130 })),
  )

  expect(result.source).toBe('OGC WMS')
  expect(result.url).toContain('map=a.map')
  expect(result.url).toContain('version=1.3.0')
  expect(result.url).toContain('layers=roads')
  expect(result.url).toContain('crs=EPSG%3A4326')
  expect(result.url).toContain('bbox=40,-10,50,10')
  // 20° x 10° at 45°N: width shrinks by cos 45°.
  expect(result.url).toContain('width=800&height=566')
})

test('WMS 1.1.1 keeps lon,lat order and honours a user bbox and layer', async () => {
  const result = image(
    await plan(
      { url: 'https://x.test/geoserver/wms', bbox: '-80,30,-70,40', layers: 'other' },
      serving({ 'https://x.test/geoserver/wms?service=WMS': WMS_111 }),
    ),
  )

  expect(result.url).toContain('version=1.1.1')
  expect(result.url).toContain('srs=EPSG%3A4326')
  expect(result.url).toContain('layers=other')
  expect(result.url).toContain('bbox=-80,30,-70,40')

  const fromCaps = image(await plan({ url: 'https://x.test/geoserver/wms' }, serving({ 'https://x.test/': WMS_111 })))
  expect(fromCaps.url).toContain('layers=topp%3Astates')
  expect(fromCaps.url).toContain('bbox=-124,24,-66,50')
})

test('WMS ServiceException text is the error', async () => {
  const xml = '<ServiceExceptionReport><ServiceException code="X">Bad key</ServiceException></ServiceExceptionReport>'
  let message = ''
  try {
    await plan({ url: 'https://x.test/wms' }, serving({ 'https://x.test/': xml }))
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toBe('Bad key')
})

test('OGC API - Maps follows the landing page map link, or takes a /map URL', async () => {
  const landing = JSON.stringify({
    links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/map', href: 'https://x.test/api/collections/a/map' }],
  })
  const viaLink = image(await plan({ url: 'https://x.test/api/collections/a' }, serving({ 'https://x.test/api/collections/a?f=json': landing })))
  expect(viaLink.source).toBe('OGC API - Maps')
  expect(viaLink.url).toBe('https://x.test/api/collections/a/map?width=800&height=378&f=png')
  expect(viaLink.accept).toBe('image/png')

  const direct = image(await plan({ url: 'https://x.test/api/collections/a/map', bbox: '0,0,10,10' }, never))
  expect(direct.url).toBe('https://x.test/api/collections/a/map?width=800&height=803&f=png&bbox=0,0,10,10')
})

test('XYZ template picks a zoom that stays within a 4x4 grid', async () => {
  const world = await plan({ url: 'https://tile.test/{z}/{x}/{y}.png' }, never)
  if (world.kind !== 'tiles') throw new Error('expected tiles')
  expect(world.columns).toBeLessThanOrEqual(4)
  expect(world.urls).toHaveLength(world.columns * world.rows)
  expect(world.urls[0]).toMatch(/^https:\/\/tile\.test\/2\/0\/0\.png$/)

  const city = await plan({ url: 'https://tile.test/{z}/{x}/{y}.png', bbox: '-0.2,51.4,0.0,51.6' }, never)
  if (city.kind !== 'tiles') throw new Error('expected tiles')
  expect(city.columns * city.rows).toBeLessThanOrEqual(16)
  expect(city.caption).toMatch(/^zoom 1[0-9] /)
})

test('sizeFor keeps the aspect at the height cap and ignores a non-numeric width', () => {
  // 1° x 10° box: 800 wide would need ~8000 rows; shrink the width instead of stretching.
  expect(sizeFor(0.1)).toEqual({ width: 200, height: 2000 })
  expect(sizeFor(2, Number('abc'))).toEqual({ width: 800, height: 400 })
  expect(sizeFor(2, 10)).toEqual({ width: 64, height: 64 })
})

test('parseMarkers takes one or more lon,lat with optional one-line labels', () => {
  expect(parseMarkers('-73.98566,40.74844')).toEqual([{ lon: -73.98566, lat: 40.74844 }])
  expect(parseMarkers('2.29,48.86,Eiffel Tower, Paris')).toEqual([{ lon: 2.29, lat: 48.86, label: 'Eiffel Tower, Paris' }])
  expect(parseMarkers('1,2,two\nlines')).toEqual([{ lon: 1, lat: 2, label: 'two lines' }])
  expect(parseMarkers('2.29,48.86,Eiffel Tower; 2.34,48.86 ;2.35,48.85,Notre-Dame;')).toEqual([
    { lon: 2.29, lat: 48.86, label: 'Eiffel Tower' },
    { lon: 2.34, lat: 48.86 },
    { lon: 2.35, lat: 48.85, label: 'Notre-Dame' },
  ])
  expect(parseMarkers(undefined)).toBeNull()
  expect(parseMarkers(';')).toBeNull()
  expect(parseMarkers('200,10')).toBeNull()
  expect(parseMarkers('10')).toBeNull()
  expect(parseMarkers('a,b')).toBeNull()
  expect(parseMarkers('1,2;a,b')).toBeNull()
})

test('several markers: each lands on its pixel, labels join the caption', async () => {
  const paris = await plan({ url: 'https://tile.test/{z}/{x}/{y}.png', bbox: '2.22,48.81,2.47,48.91', marker: '2.2945,48.8584,Eiffel Tower;2.3376,48.8606' }, never)
  if (paris.kind !== 'tiles' || !paris.frame) throw new Error('expected tiles with a frame')
  expect(paris.markers).toHaveLength(2)
  expect(paris.caption).toBe('zoom 12 · 4×2 tiles · Eiffel Tower')
  const size = { width: paris.columns * 256, height: paris.rows * 256 }
  const [eiffel, louvre] = paris.markers!.map(({ lon, lat }) => markerPixel(paris.frame!, size, lon, lat))
  expect(louvre.x).toBeGreaterThan(eiffel.x)
})

test('ArcGIS marker lands on its Web Mercator pixel', async () => {
  const info = JSON.stringify({ mapName: 'Layers' })
  const result = image(
    await plan(
      { url: 'https://x.test/rest/services/Gray/MapServer', bbox: '-73.9989,40.7424,-73.9725,40.7544', width: 900, marker: '-73.98566,40.74844,Empire State Building' },
      serving({ 'https://x.test/rest/services/Gray/MapServer?f=json': info }),
    ),
  )
  expect(result.url).toContain('size=900%2C540')
  expect(result.caption).toBe('Layers · EPSG:3857 · Empire State Building')
  if (!result.frame) throw new Error('expected a frame')
  // Checked by hand on the drawn map: 5th Ave at W 34th St.
  const { x, y } = markerPixel(result.frame, { width: 900, height: 540 }, -73.98566, 40.74844)
  expect([Math.round(x), Math.round(y)]).toEqual([451, 268])
})

test('WMS marker is linear in degrees; tiles marker is Web Mercator over whole tiles', async () => {
  const wmsPlan = image(
    await plan(
      { url: 'https://x.test/geoserver/wms', bbox: '-80,30,-70,40', marker: '-75,35' },
      serving({ 'https://x.test/geoserver/wms?service=WMS': WMS_111 }),
    ),
  )
  if (!wmsPlan.frame) throw new Error('expected a frame')
  expect(markerPixel(wmsPlan.frame, { width: 800, height: 600 }, -75, 35)).toEqual({ x: 400, y: 300 })

  const world = await plan({ url: 'https://tile.test/{z}/{x}/{y}.png', marker: '0,0' }, never)
  if (world.kind !== 'tiles' || !world.frame) throw new Error('expected tiles with a frame')
  const size = { width: world.columns * 256, height: world.rows * 256 }
  const { x, y } = markerPixel(world.frame, size, 0, 0)
  expect([Math.round(x), Math.round(y)]).toEqual([size.width / 2, size.height / 2])
})

test('a marker is refused when it cannot be placed', async () => {
  const cases: [TInput, (url: string) => Promise<string>, RegExp][] = [
    [{ url: 'https://tile.test/{z}/{x}/{y}.png', marker: 'nope' }, never, /^marker must be/],
    [{ url: 'https://tile.test/{z}/{x}/{y}.png', bbox: '0,0,10,10', marker: '20,20' }, never, /^marker 1 is outside the map/],
    [{ url: 'https://tile.test/{z}/{x}/{y}.png', bbox: '0,0,10,10', marker: '5,5,in;20,20,out' }, never, /^marker 2 is outside the map/],
    [{ url: 'https://tile.test/{z}/{x}/{y}.png', marker: Array(21).fill('0,0').join(';') }, never, /^at most 20 markers/],
    [{ url: 'https://x.test/api/collections/a/map', marker: '1,1' }, never, /pass bbox/],
  ]
  for (const [input, get, pattern] of cases) {
    let message = ''
    try {
      await plan(input, get)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(pattern)
  }
})

test('bad input is refused before any request', async () => {
  for (const input of [{ url: 'file:///etc/passwd' }, { url: 'https://x.test/wms', bbox: 'nope' }]) {
    let message = ''
    try {
      await plan(input, never)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toBe('')
  }
})
