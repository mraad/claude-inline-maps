import { expect, test } from 'claude-code/testing'

const MAP_ROW = {
  plugin: 'inline-maps',
  component: 'CommandOutput',
  surface: 'terminal',
  props: {
    command: 'map',
    args: 'https://ows.terrestris.de/osm/service',
    text: 'OGC WMS: OSM-WMS · WMS 1.3.0 · 600×375\n/var/folders/x/inline-maps.abc/map-1.png',
    isErrored: false,
  },
} as const

test('/map output draws the picture from its path, with or without the plugin prefix', async $ => {
  for (const prefix of ['', 'inline-maps: ']) {
    const ui = await $.ui.mount({ ...MAP_ROW, props: { ...MAP_ROW.props, text: prefix + MAP_ROW.props.text } })

    expect(await ui.find({ type: 'Image' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /OGC WMS/ }))?.text).toBe('OGC WMS · OSM-WMS · WMS 1.3.0')
    await ui.unmount()
  }
})

test('/map usage and error rows stay text', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  for (const text of ['map failed: HTTP 500 (text/xml): unknown layer: nope', 'Usage: /map <url>']) {
    const ui = await $.ui.mount({ ...MAP_ROW, props: { ...MAP_ROW.props, text } })

    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
})
