# LinesController display transfer (from RPCS3 RenderDoc captures)

Captures in `Новая папка/`: `xmb_idle.rdc` (night, 25 Oct 22:13), `xmb_day_whilte.rdc`, `xmb_day_yellow.rdc`
(daytime, 23 Dec 16:42 and 3 Nov 16:40), `xmb_day_red.rdc` (no LinesController draw: not a normal XMB frame).
Dumped with `rd_dump.py` / `rd_dump_lc.py` (headless qrenderdoc --python; the LC variant finds the draw that reads two
128x128 R16G16_FLOAT textures): idle EID 205, white EID 196, yellow EID 228.

## The pass (moyou/LinesController.fpo as RPCS3 runs it)

- inputs: tex1 `_Back` 128x64 RGBA16F (rows bottom-up), tex0 lines target (BGRA8, decoded x/32 + y/2 with
  x = G byte, y = R byte), tex13 noise 32x32, tex14 / tex15 the ExposeTex tables (128x128 R16G16F),
  tc2 = vertical background gradient, tc3 = line colour.
- `x8 = 8 * (back * tc2 + lines * tc3)`; `r0.xy = tex15((x8.r, x8.g) / 128).xy + noise.xy * 0.125`;
  `r0.zw = tex14((max(x8.r, x8.g), x8.b) / 128).zw + noise.zw * 0.125`; output r0 rounded to 8 bits. This is the
  displayed frame (later draws only add glare, EID 611, and the UI).
- constants (all three captures): fc = (0.25, 0.25), (1/1920, 1/1080), 1/32, 1/2, 1/8, 1/8; tex14/15 coordinate
  scale 1/128.

## The tables

- tex15: both channels are linear ramps of the coordinates, value = texel * exposure / 8
  (night 0.1776 per texel = 1.42 / 8; both day captures 0.1509 = 1.21 / 8, the dusk preset's exposure).
- tex14: one channel the same ramp, the other about ramp^2 / 8 minus 0.015 * texel (NaN at texel 0).
- They depend only on the time-of-day exposure: the white and yellow tables are identical.

## Measured transfer

Background-only pixels, output vs x = back * gradient, all three captures (spread within bins ~4/255, the dither):

    out = exposure * (x - 1/16), clamped to 0..1      (1/16 = half a table texel at the x8 scale)

e.g. night x 0.15 -> 32 (formula 31.7), white day x 0.5 -> 135 (135), x 0.7 -> 193 (197).

## back_colours0 inputs (the background program itself is exact)

Capture times: white 23 Dec 16:42, yellow 3 Nov 16:40 (XMB clock). The idle capture's inputs say 26 Oct 00:56:31,
not the 22:13 read from its clock (all four inputs agree on that time).
back_colours0 draw: idle EID 36, white/yellow EID 32 (`rd_dump_back.py`: the draw reading four 64x32 textures).
Only six constants differ between captures (RPCS3 fc index within the program):

| fc | uniform | 26 Oct 00:56 | 23 Dec 16:42 | 3 Nov 16:40 |
|----|---------|------|------|------|
| 0 | u_NightTime | 1294.19 | 471.445 | 467.861 |
| 17 | u_DayTime | 234.328 | 1336.48 | 1334.52 |
| 93 | u_MonthTime | 24.1936 | 21.2903 | 2.0 |
| 139 | u_NightBrightness | 0.216 | 0.1205 | 0.0587 |
| 142 | u_NightDayBlend | 0.5439 | 1.0 | 1.0 |
| 143 | u_Alpha | 3.226 | 1.918 | 2.508 |

### How the PS3 computes them (custom_render_plugin.prx, solved)

- fn_10900: t = (h*3600 + m*60 + s) / 86400 -> object+0x1d0; month position (month-1) + (day-1)/days -> +0x1d4
  (days table has February = 28; 29 Feb uses 27/28).
- fn_52ad8 (every frame) writes the eight parameters in registration order (0x2c DayTime, 0x40 NightTime,
  0x54 MonthTime, 0x68 Alpha, 0x7c Exposure, 0x90 WhiteSqrRcp, 0xa4 NightDayBlend, 0xb8 NightBrightness):
  - DayTime = 2400 * Hermite(t; 0 -> 1, both tangents DAYSPREAD) (fn_52a28 / fn_4faf0 basis 2,-3,0,1 ...)
  - NightTime = 2400 * frac(t - 0.5)
  - MonthTime = frac(month position) * 30
  - NightDayBlend = 1 + (ss(N2D BEGIN/24, N2D END/24, t) * (1 - ss(D2N BEGIN/24, D2N END/24, t)) - 1) * NIGHT BLEND
    (ss = fn_3e980 smoothstep); the hours / 24 are done when the settings are applied (0x218d8)
  - NightBrightness = NIGHT WHIT BIAS; Alpha = a cross-fade factor (1 when idle)
- BACKGROUND.mnu (day/night/yoake/higure overrides): NIGHT BLEND 0.499947, N2D 0..5.16611, D2N 18.498..20.3312,
  DAYSPREAD 2.68038, NIGHT WHIT BIAS 0.486059.
- Check: DayTime 234.318 / 1334.52 (captured 234.328 / 1334.52), NightDayBlend 0.54385 (0.5439). The captured
  fc139 / fc143 values do not match NightBrightness / Alpha, but neither matters: NightBrightness is a floor
  (max) that never binds at the sampled pixels, u_Alpha only reaches the output alpha.
- Driven by the clock alone, our back_colours0 matches the PS3 `_Back` within ~0.004 in all three captures
  (`back_compare.mjs`). Implemented in `src/background_inputs.js`, used by the scene and the web version.

## In use

The scene (`xmbTone` in tools/build_we_scene.mjs) and the web version (background.frag.glsl subtracts 1/16,
tone.frag.glsl multiplies by the exposure) use the linear law; the A * x^1.8 stand-in, the white-level curve and
the highlight knee are gone. Clock -> back_colours0 -> linear law vs the PS3's final frames, at seven
background-only pixels per capture: within 1/255 in all three (`display_check.mjs`, session scratchpad).

## Time-of-day presets (solved)

custom_render_plugin.prx fn_11600 (keyframe table at 0x9c98c, {day fraction, override name}): night 0-1 h,
night -> yoake 1-5, yoake 5-7, yoake -> day 7-11, day 11-13, day -> higure 13-17, higure 17-19, higure -> night 19-23,
night 23-24. Between keyframes fn_39d6c blends the two overrides; the weight is a smoothstep (16:42 -> exposure 1.2072
= measured; linear gives 1.1985). The ExposeTex slopes read 128/127 high (night 1.4208 = 1.41 x 128/127).
Implemented for the exposure in `src/time_presets.js` (scene: PS3 curve; web: 'auto' preset with the PS3 curve).

## Ribbon pixels (checked 2026-11-13)

- LinesController's colour channels are linear: tex15 / tex14 are separable ramps (texel * exposure / 8) for R, G, B;
  the nonlinear column of tex14 (about ramp^2, fed by max(r, g, b)) goes to alpha only (glare).
- In the captured lines target (B8G8R8A8 dump) the fine part of _Encode is the R byte and the coarse part the G byte:
  lines = R / 255 / 32 + G / 255 / 2 (the earlier analysis had them swapped; the renderer was not affected). With
  that, ribbon pixels follow exposure * (back + lines * colour3 - 1/16) within ~4 / 255 over the whole range, and the
  lines distribution is p50 / p90 / p99 0.073 / 0.181 / 0.294 (ours 0.095 / 0.177 / 0.258). _Colour3 in the
  capture is (0.847, 0.846, 0.846), the BACKGROUND.mnu value.
- The transfer has to see the summed sheets: blending each sheet as tone(back + sheet) - tone(back) loses the
  channels whose background is below 1/16 (blue and green at night) wherever faint sheets overlap, and the ribbon
  turns the background's red / yellow. The Wallpaper Engine scene ('Ribbon blending: PS3') writes every layer
  encoded as 0.1 + 0.9 * value (background as exposure * (back - 1/16), ribbon and particles linear, additive), and
  a full-screen effect over the finished frame ('XMB lines transfer') decodes (frame - 0.1) / 0.9 and clamps, so the
  floor is applied once to the sum. The per-sheet way stays as 'Previous'.
- Wallpaper Engine facts found on the way (3D scene, script-created model layers): sortLayer does not change the
  draw order; 'normal' (opaque) materials are drawn before translucent / additive ones whatever the layer order; and
  _rt_FullFrameBuffer is copied before the script layers are drawn, so a layer cannot read what earlier layers drew.
  A scene.json full-screen effect layer does see the whole finished frame.
- After the fix, 13 Nov 00:3x, our scene vs the PS3 (RPCS3 screenshot), ribbon pixels at red ~55 / ~70:
  (55, 44, 36) / (70, 59, 51) vs (54, 38, 29) / (72, 58, 48); green - blue 8 vs 9-10 (was ~0 before).

## Ribbon intensity: the highlight term (checked 2026-11-13)

- Rasterising the captured lines1 vertices (xmb_idle EID 192, 128 x 128 grid, post-VS outputs) with our fragment
  program and comparing with the captured lines target isolates the fragment stage. With the stripe term dropped
  (the earlier assumption) the result was only 64% of the PS3's intensity (p90 0.116 vs 0.181), although geometry,
  per-vertex lod (p50 0.08 / p90 0.26) and constants (Fresnel 0.52, spacing 408.298, thinness 1) all match.
- Best fit over the possible channel assignments: _FresLUT.x = the falling curve (byte 1 of freslut_512x1.bin, the
  B channel of freslut1.tga), _FresLUT.y = byte 4 (a highlight bump: 0 below u = 15, peak 252 at u = 29, tail to
  u = 114; RPCS3 remaps this texture's channels), and the stripe lookup = 127 / 255 (_Stripes is 127 in every
  texel, so the 0 / 0 coordinate with _Thinness = 1 does not matter). Correlation 0.986, RMS 0.025 (was 0.978,
  0.046); intensity 82% of the PS3's.
- The web version (wave.frag) and the Wallpaper Engine scene (xmb_freslut.tex, bump in red) now add
  bump * brightness * lod * 127 / 255. Web lines target at ~18% coverage: p50 / p90 / p99 0.078 / 0.164 / 0.302
  (PS3 0.073 / 0.181 / 0.294; before 0.059 / 0.106 / 0.198).

## Particles: web vs scene vs PS3 (checked 2026-11-13)

- PS3 order (xmb_idle): LinesController 205, glare 218-611, particles 634 (quads) + 640 (second), UI from 645. The
  sparks are added to the finished frame, after the glare; nothing floors them.
- Spark statistics at 1080p (high-pass = frame minus its 7x7 opening, threshold 8 levels; on the PS3 frame it
  matches the exact after-minus-before within a few %): PS3 ~955-1120 sparks, peak p50 / p90 / p99 19-23 / 54-62 /
  203-213, size p50 7-8 px. Web: 1186, 21 / 93 / 213, 5 px. Scene (ribbon blending 'sum'): ~820, 9 / 19 / 146, 1 px.
- The scene's 'sum' mode floored the sparks with the background (faint ones vanished over black). Fixed: each spark
  carries the background's floor deficit at its screen position (TANGENT_SIGNED.w, from back.sampleAt) and adds
  min(spark, deficit) back.
- The scene's sparks were also ~4x too dark and small in any blending mode: Wallpaper Engine's 'additive' material
  blending is (src alpha, one), and the RSX particle programs write a small alpha (p50 0.10); the PS3 adds them with
  (one, one). The scene's particle shaders now write alpha = 1. Checked by running the scene's translated shaders and
  the web's on the same particle data in WebGL (identical with (one, one); 4.2x darker with (src alpha, one)).
  Scene after the fix: 1640-1870 sparks, peak 13-18 / 49-57 / 174-202, size 3-4 px (PS3 above).
- Testing notes: Wallpaper Engine's log.txt has not been written since 2026-10-28 (shader errors are not visible
  there any more); it caches compiled shaders in shaders/blobsSM40 and rebuilds them only when the source is newer
  (restoring an older copy of a shader keeps the cached diagnostic version: rebuild instead); capture test windows
  with PrintWindow, not CopyFromScreen (the window may not be in front).

## Hand-written particle programs and the public (procedural) build (2026-11-15)

- src/shaders/sparks.* and glare.* (shared parts in particles_lib.glsl) replace the translated particles_quads /
  particles_second in the web version and the scene. tools/check_particles.html draws 400 random particles with both
  at each time-of-day preset into float targets: sparks within 1.5e-3 (the RSX atan polynomial vs atan(), edge
  pixels only), glare within 2e-6. The translated glare program reads literal 1 instead of _Iridescent for red and
  blue; every preset has 'iridescent exp' = 1, so this never shows.
- Wallpaper Engine shader dialect: it declares only the attributes it sees used in code, not in #define lines
  (error X3004 undeclared identifier 'a_Normal'): tools/we_shader.mjs glslToWe puts the inputs into locals at the top
  of main(). Also avoided: out parameters, names of HLSL intrinsics as identifiers (lit, rsqrt), matrices; glslToWe
  rejects them.
- log.txt is written again (shader errors appear there within seconds of a rebuild while the wallpaper runs).
- Procedural scene (build_we_scene.mjs --assets=procedural) checked in Wallpaper Engine: background, ribbon (relaxed
  generated start, we_scene/lines_core.js relax) and sparks render. Month surfaces vs the originals: mean 0.66 / 255,
  worst texel 17 / 255 (August, day).
- Ribbon start (2026-11-15, later): the 10 s damped relaxation left a calm sheet (kinetic energy 176, bending 0.085,
  against the firmware snapshot's 7800 / 0.21) that took ~5 minutes to reach the firmware's state of motion. Now a
  20 s warm-up at damping x16 and kicks x4 (~55 ms): bending matches from the first frame, energy within ~25%. The
  opening pose still differs (the firmware's is one particular frozen moment, a twisted bundle nearly edge-on).
- Ribbon start, revised: judged by the ribbon's height on screen (full pipeline, we_scene/lines_core.js), the x16 / x4
  warm-up fanned the sheet out (0.25 of the screen height in the first 30 s, firmware 0.13-0.15). Now x4 / x2 for
  40 s: first 40 s 0.17-0.18 at every preset (firmware 0.17-0.18), 0.16-0.20 afterwards (firmware 0.20-0.25 in
  minute 2). Over 30 minutes both hover at 0.13-0.20. The CPU FFD (ffd_cpu.js) matches the translated
  ffd_shader1 to 4e-7, so the lattice plays no part in the difference.
- Ribbon start, final: any warm-up from a made-up shape was wrong in a way the height measure (averaged over covered
  screen columns) hid: the generated rows were 0.095 apart against a 0.306 rest length, the sheet buckled and the
  ribbon contracted to 3.6-4.4 units long (firmware 6.1), covering half the screen width and bunched up for 1-2
  minutes. Now the start is a stored state of our own simulation: the grid seed (src/procedural/grid_seed.js) after
  610 s of physics with the night preset (tools/make_public_data.mjs). Picked from a 30-minute run by its likeness to
  the firmware snapshot's statistics (length 5.90 vs 6.11, cross-section 1.11 x 1.29 vs 1.12 x 1.26, row spacing
  0.354 vs 0.355). On screen: full width from the first frame, height 0.09 / 0.10 / 0.16 / 0.13 at 0 / 5 / 10 / 20 s
  (firmware 0.09 / 0.12 / 0.11 / 0.15). No warm-up any more.
- Sparks' tint (proc_iridescent, 128 x 128): a 1-D palette along a one-armed spiral, s = theta / 2pi + K r^P around
  the centre (r = 1 at the edge); binned by s, the colour spreads only 3.3 / 255 rms (60 over the whole texture).
  Fitted K = -0.2425, P = 2 and a periodic piecewise-linear palette of 32 knots (tools/make_public_data.mjs ->
  src/procedural/iridescent.js): rms 1.83, max 10 / 255. A Fourier palette needs ~16 harmonics for the same error
  (sharp turns at the white and blue ends).

## Exact-mode setup from an RPCS3 folder (2026-11-15)

- tools/setup_extracted.mjs reads dev_flash/vsh/resource/qgl/lines.qrc: 'QRCC', u32, zlib -> 'QRCF' with big-endian
  (offset, size) sections at 0x08: node table, name table, tag strings ('qrc', 'file-table', 'file', 'src', 'id'),
  two empty ones, data. File node: 'src' type 6 (offset, size in the data section), 'id' type 7 (offset of a
  [u32][path\0] record in the name table). 159 files, identical to the earlier extracted_lines/.
- No RenderDoc capture needed: textures/TGA/freslut1.tga (24-bit B, G, R) is _FresLUT byte for byte as lines1 reads it
  (B, G, G, R); the stripes table is unused with THINNESS = 1; the encoding table is built by the plugin at run time,
  the generated one (capped at 0.5077 like it) differs by at most 0.0021 below intensity 0.5.
- Month .dds: uncompressed A8R8G8B8 64 x 32 (mip 0 first); proc_iridescent.tga 32-bit bottom-up. Converted PNGs are
  identical to the earlier ones; rsx2glsl output identical to the shaders in use.
- Only the ribbon's start snapshot needs the decrypted plugin (RPCS3 Utilities > Decrypt PS3 Binaries); without it
  the generated start is used.
- The decrypted plugin is no longer used anywhere: the ribbon's start is always the generated one (it was the only
  data still read from custom_render_plugin.prx). 'Ribbon start' setting: fixed (the generated start, the same motion
  every time, as the PS3 with its snapshot and its fixed noise counter) or random (src/procedural/random_start.js:
  random noise seed, then 10-40 s of physics; openings 0.27-0.43 rms apart, full length).

## Background image and liquid glass ribbon (2026-11-16, not on the PS3)

- Composite (background.frag.glsl): an image enters as x = colour * gain / exposure + 1/16, so the PS3 transfer shows
  it at its own colours; the blur is the canvas Gaussian on an edge-extended copy (custom_image.js).
- Glass: ribbon_glass.* draws the sheets again into a float target, summing (normal.xy * w, w, edge-on * w), w = the
  capture's edge weight. The composite refracts the background by the mean normal (liquidglass's dual-surface factor,
  thicker where sheets overlap), splits R / B along the normal, mixes a blurrier mip level, and adds liquidglass's
  four-light specular, Fresnel and rim at display level. The PS3 line light stays at 45% on the glass.
- Glass, revised after a look up close: the glass pass is drawn 4x multisampled and resolved; each sheet's weight
  fades with smoothstep(0, 0.35, |N.z|) as it turns edge-on, and the refraction uses the summed normals (not their
  mean), so it no longer jumps in blocks where folded sheets start to overlap. No frosted core any more (it sampled
  mip level 3, which looked low-res): sharp samples, liquidglass's default.
- Glass controls: refraction (0-5), chromatic aberration, frost (the image blurred more, mixed in), shine (Fresnel and
  specular), edge smoothing (jittered glass passes blended into a history; also turns on 8x MSAA for the line light,
  whose fine / coarse encoding decodes linearly). Measured over the PS3 background (pixels whose luminance jumps more
  than 6 levels from the mean of their 4 neighbours, 1024 x 768): PS3 ribbon 2952; glass before 8681; almost all of it
  was the highlights (shine off: 253). Lighting now uses the glass buffer blurred over ~3 x 3 px with a weight floor,
  and Toksvig-like specular AA (exponents / (1 + 150 |fwidth(n)|^2), energy kept): 2217 at the defaults.
- Temporal smoothing removed again (it looked bad); multisampling of the glass and line passes stays on in glass
  mode. Glass settings now in one list (src/glass_settings.js): refraction, thickness, chromatic aberration, frost,
  distortion, Fresnel, specular, edge highlight, cool tint, saturation, brightness, line glow; liquidglass's terms.

## Custom background colour (2026-11-16, not on the PS3)

- PS3 month textures, mean colours day vs night: night keeps the hue (within 7 degrees), value x 0.27-0.59 (median
  0.46), saturation x 0.4-1.0 (median ~0.7); autoNight uses 0.46 / 0.7 (mean distance from the real night colours
  0.12 in RGB 0..1). custom_colour.js recolours the current month's textures (colour x luminance / mean luminance)
  and feeds them to back_colours as this and next month, so the cycle is the PS3's. Page, web wallpaper, scene.

## Image background and liquid glass in the Wallpaper Engine scene (2026-11-16)

- User image: project.json property type 'scenetexture' (bg_image); scene.json binds it to the effect's texture slot 1:
  passes: [{ textures: [null, 'util/black'], usertextures: [null, 'bg_image'] }] (format seen in installed workshop
  scenes). The script sets the effect's values with getLayer('XMB lines transfer').getEffect(0).setMaterialProperty.
- The effect 'XMB lines transfer' decodes the frame; in image mode the background layer writes 1/16 (nothing after
  the transfer) and the image goes behind. Blur: Gaussian over a 64-tap disc with per-pixel angle and radius offsets,
  always from mip level 0 (texSample2DLod): a fixed pattern showed rings, and with per-pixel offsets the hardware's own
  level choice jumped to tiny mips (blocks); explicit coarser levels also looked blocky.
- Glass: the decoded light is liquidglass's height field (slope over +-2 px), coverage = light above its 12 px ring
  average; the sparks become small glass bubbles (kept on purpose). Tested in a playInWindow capture with
  --test-fx (generated test picture) and --test-glass (PS3 background).
- Scene image fit, fixed: imported images are stored padded to a power of two with the image in the top-left corner;
  g_Texture1Resolution.xy is the texture size, .zw the image's own size. The fit used .xy as the image, so a user's
  image showed enlarged. Now 'cover' on .zw, mapped into the occupied part, blur samples clamped to it. Checked with a
  padded 4:3 test picture (1000 x 750 in 1024 x 1024): full width with its frame at the sides, top and bottom cropped.
- Scene image fit, second fix (the padding theory was wrong): Wallpaper Engine stretches an imported image to a
  power-of-two texture and reports its own size in g_Texture1Resolution.zw; the 'cover' fit now uses zw for the
  aspect and 0..1 for the coordinates (a 16:9 image on 16:9 fills the screen exactly; checked with a 1600 x 900 test
  picture stored stretched to 1024 x 1024). Added 'Image fit: cover / stretch' in case a texture reports no size.
- Third look at the scene image (user reports: Cover enlarged, Stretch right vertically but wide horizontally): the
  user's image arrives cropped to the shape of the slot's default texture, which was the square util/black (a 16:9
  image came in as its centre square). The slot's default is now xmb_bgdefault, black 1280 x 720 (16:9).
  applyProperties did not reach a -playInWindow test window, so this is inferred from the two reports, not reproduced.
- 2026-11-16: the image background and the liquid glass ribbon left the main builds; they stay in experimental ones
  (build_wallpaper.mjs / build_we_scene.mjs --experimental, page ?experimental, XMB_EXPERIMENTAL). The custom colour
  stays in the main builds. The scene's user image fit is still unresolved.
