# PS3 XMB background

[![Open XMB: the PS3 XMB background running in a browser. Click for the live demo.](docs/preview.jpg)](https://whodokter.github.io/Open-XMB/)

*Click the picture for the live demo in your browser.*

A complete reimplementation of the PlayStation 3 XMB background with some additional features. It runs in a browser
(WebGL 2) and as a Wallpaper Engine web wallpaper, and has a Wallpaper Engine 3D scene version (which also works in
Wallpaper Engine for Android) available on Steam Workshop.

It was rebuilt by studying how the console draws its background: most of its aspects follow the firmware's behaviour
extremely closely and were checked against RPCS3 captures. No firmware files are included and none are needed for an
average user. The colours, textures and tables the console reads from its files are generated as *really* close
stand-ins instead (see [Assets](#assets)). However, there is an option to make use of the original assets for your own
copy of the build (see [Exact mode](#exact-mode)).

Not affiliated with or endorsed by Sony Interactive Entertainment. "PlayStation" and "XMB" are trademarks of their
owners.

## Run it

No installation needed. From [Releases](../../releases), download:

- **`PS3-XMB.html`**: one file, everything inside. Open it in a browser (double-click); it works offline.
- **the web wallpaper** (zip): unpack it and add it in Wallpaper Engine with *Open from file*, picking `index.html`.

The 3D scene (also for Wallpaper Engine on Android) is on Steam Workshop.

`H` shows or hides the settings: preset, month and day, time of day (or a time-lapse of a whole day), ribbon speed,
how the sparks react to the pointer, particle amount, brightness curve, the ribbon start (*fixed* opens the same way
every time, like the PS3; *random* with a new opening each time) and the background colour. In Wallpaper Engine the
same settings are in the wallpaper's properties.

Additions that are not on the PS3 (page, Wallpaper Engine web wallpaper and 3D scene):

- **Custom colour**: pick a day colour, and a night colour or let it follow the day one as the PS3's own night
  textures do. The month textures are recoloured with their brightness pattern kept, so the PS3's day / night cycle
  runs on your colour.
- **Particle effects**: the PS3 had only one user interaction with the particles: shaking the controller would shake
  all of them. On PC with keyboard and mouse that is not a great solution, so there is an option for the closest
  particles to follow your mouse (great for PC) and for all of them to fling with the cursor (works best as a phone
  wallpaper).
- **Colour grading**: I had to change the brightness curve, colour grading and time cycle several times for it to
  resemble the PS3 version closely. The classic version could be more pleasing to some people, as it is more vibrant.

## For developers

Building and the live page need [Node.js](https://nodejs.org) 20.11 or newer (there are no dependencies to install).

### Live page

```bash
node app/tools/serve.mjs
```

Then open <http://localhost:8080/app/>. This page is the source itself, split into many modules, shaders and data
files, which is why it needs a small local server: browsers do not let a page opened from disk (`file://`) load its
modules and files. Changes show on reload. For a page that opens from disk, build the single HTML file below.

### Single HTML file and web wallpaper

```bash
node app/tools/build_wallpaper.mjs --assets=procedural
```

writes `dist/PS3-XMB-procedural.html`, one file that opens straight from disk, and `dist/wallpaper/`, a Wallpaper
Engine web wallpaper (add it in Wallpaper Engine with *Open from file*, pick `dist/wallpaper/index.html`). These are
what goes into Releases (the HTML file as `PS3-XMB.html`).

Only builds with `--assets=procedural` may be shared. Builds with your own firmware files (`--assets=extracted`, the
default once [Exact mode](#exact-mode) is set up) contain Sony's data and are for your own use only.

### Wallpaper Engine 3D scene

Make an empty 3D scene project in the Wallpaper Engine editor and save it, then:

```bash
node app/tools/build_we_scene.mjs "<Wallpaper Engine>/projects/myprojects/<your project>" night --assets=procedural
```

This adds a script object that draws the background, ribbon and sparks, plus its shaders and materials. The last
argument before the options is the preset whose particle look is baked in (`night` by default); the time of day
still follows the clock. Settings appear in the wallpaper's properties.

### Experimental builds

Two more additions are kept out of the main builds and are only in experimental ones:

- **Background image**: any picture instead of the month colours, with an adjustable Gaussian blur and brightness.
- **Liquid glass ribbon**: the ribbon's sheets refract what lies behind them, with chromatic fringes, frost, Fresnel
  rims and specular highlights, after [liquidglass](https://github.com/ybouane/liquidglass) by ybouane (MIT), with
  12 settings.

They are kept as experimental as I was unable to port them properly to the 3D scene version, and they are mostly
gimmicks.

```bash
node app/tools/build_wallpaper.mjs --experimental
node app/tools/build_we_scene.mjs "<project>" --experimental
```

The first writes `dist/PS3-XMB-experimental.html` and `dist/wallpaper-experimental/`; in the live page,
`?experimental` turns them on (<http://localhost:8080/app/?experimental>).

## Assets

The console reads its look from data files. This project generates each of them:

| Firmware data | Here | How close |
| --- | --- | --- |
| Month backgrounds (12 x day / night, 64 x 32) | a degree-4 polynomial surface per colour channel, 15 numbers each (`app/src/procedural/months.js`) | mean 0.66 / 255, worst texel 17 / 255 |
| Preset parameters (`.mnu`) | the 111 values the code reads (`app/src/procedural/presets.js`) | the same numbers |
| Spline weight tables | the uniform cubic B-spline basis, computed | exact |
| Ribbon Fresnel / highlight table | fitted curves | within the table's 8-bit steps |
| Ribbon start state | our own grid seed after 610 s of the ribbon physics, stored (`app/src/procedural/ribbon_start.js`, made by `app/tools/make_public_data.mjs`) | full screen width and the same height from the first frame; same length, cross-section and row spacing |
| Sparks' tint texture (128 x 128) | a one-armed spiral, colour = palette(θ/2π − 0.2425 r²), the palette 32 fitted colours (`app/src/procedural/iridescent.js`) | rms 1.8 / 255, worst channel 10 / 255 |
| Line encoding table | its own fine / coarse split | equivalent |

`app/compare.html` shows the generated assets next to the originals when you have them.

### Exact mode

To use the PS3's own files instead, install the PS3 firmware in [RPCS3](https://rpcs3.net) (*File > Install
Firmware*, with the `PS3UPDAT.PUP` from Sony's site), then point the setup at RPCS3's folder:

```bash
node app/tools/setup_extracted.mjs "<RPCS3 folder>"
```

It unpacks `dev_flash/vsh/resource/qgl/lines.qrc` into `extracted_lines/` and converts what the renderer reads into
`assets/` (month backgrounds, the sparks' tint, the ribbon's Fresnel table, the spline tables) and `app/src/shaders/`
(the ribbon lattice and background programs, translated). Nothing is copied into the repository's tracked files.

Only `lines.qrc` is read. The one other thing the PS3 keeps for this background, the ribbon's starting state, sits
in the encrypted `custom_render_plugin.sprx`; the generated start stands in for it in both modes.

Then open the live page as usual (`auto` picks the files up, or `?assets=extracted`), and build with
`--assets=extracted`. `app/compare.html` shows the generated assets next to these. For the particle check,
`app/tools/rpcs3dump2glsl.mjs` translates the particle programs from an RPCS3 shader dump.

## Layout

- `app/src/`: the renderer (`main.js` wires it up). `background_pass.js` and `back_colours.js` for the background,
  `ppu_lines.js` (ribbon physics), `spu_spline.js` and `wave_renderer.js` (surface and drawing), `particles_core.js`
  and `particles_pass.js` (sparks), `hdr_pass.js` (display transfer and glare), `procedural.js` and `asset_source.js`
  (assets).
- `app/src/shaders/`: GLSL ES 3.00.
- `app/we_scene/`: the Wallpaper Engine scene script's parts, bundled by `app/tools/build_we_scene.mjs`.
- `app/tools/`: builds, checks, the extraction tools and the disassemblers used while studying the firmware.
- `app/notes/`: measurements behind the display transfer and blending.

## License

MIT, see [LICENSE](LICENSE). This covers the code and data in this repository, not the PS3 firmware or anything
extracted from it.

## Contributing

Pull requests with fixes, additions and whatnot are welcome. You can also open an issue on GitHub.
