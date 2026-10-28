import { expect, test } from 'claude-code/testing'

import { parseBbox, plan, type TPlan } from './maps'

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
  expect(result.url).toContain('size=800%2C800')
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
  expect(result.url).toContain('width=800&height=400')
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
  expect(direct.url).toBe('https://x.test/api/collections/a/map?width=800&height=800&f=png&bbox=0,0,10,10')
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
