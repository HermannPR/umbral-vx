# Third-party notices

UMBRAL VX's own code is MIT-licensed (see `LICENSE`). It ships these third-party files, each under its own license:

| Component | Files | License |
|---|---|---|
| [lil-gui](https://lil-gui.georgealways.com) 0.21.0 by George Michael Brower | `js/vendor/lil-gui.esm.min.js` | MIT (below) |
| [STIX Two Text](https://github.com/stipub/stixfonts) 2.13 | `fuentes/STIXTwoText*.ttf` | SIL Open Font License 1.1 (`fuentes/OFL.txt`) |
| [Geist Mono](https://github.com/vercel/geist-font) 1.401 | `fuentes/GeistMono.ttf` | SIL Open Font License 1.1 (`fuentes/OFL.txt`) |
| [butterchurn](https://github.com/jberg/butterchurn) 2.6.7 by Jordan Berg | `presets/milkdrop/butterchurn*.min.js` | MIT (`presets/milkdrop/LICENSE-butterchurn`) |
| [butterchurn-presets](https://github.com/jberg/butterchurn-presets) 2.4.7 (MilkDrop presets) | `presets/milkdrop/p/*.json` | MIT (`presets/milkdrop/LICENSE-butterchurn-presets`) |
| [ISF Files](https://github.com/Vidvox/ISF-Files) by VIDVOX and contributors | `presets/isf/*.fs` | MIT (`presets/isf/LICENSE`) |
| [modV](https://github.com/vcync/modV) ISF modules by vcync | `presets/modv/*.fs` | MIT (`presets/modv/LICENSE`) |
| [fosfora](https://github.com/kevinraymond/fosfora) by Kevin Raymond | `presets/fosfora/**/*.wgsl` | MIT or Apache-2.0, at your option (`presets/fosfora/LICENSE-MIT`, `presets/fosfora/LICENSE-APACHE`) |

The fonts are **not** covered by the MIT license of this repository.

### Señal presets

The *Señal* room plays presets from several engines. The third-party ones live under `presets/` and are **not** part of UMBRAL VX's own code: each folder keeps its upstream license file next to the presets, and `presets/indice.json` records the name, author and license of every preset. The room shows that credit on screen while a preset plays.

- **MilkDrop**: the presets were written by many people in the MilkDrop community (their names are part of each preset's title) and are distributed in converted form by butterchurn-presets under the MIT license. butterchurn renders them in WebGL.
- **ISF**: shader files from VIDVOX's ISF Files and from modV, used as generators or as effect layers. Each file's `CREDIT` field names its author. Files whose credit points to code under another license (for example Shadertoy or The Book of Shaders) were left out.
- **fosfora**: single-pass WGSL effects and their shared libraries, used without changes except for a small runtime adjustment of the `feedback()` helper's coordinates.

---

## lil-gui

```
MIT License

Copyright (c) 2019 George Michael Brower

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
