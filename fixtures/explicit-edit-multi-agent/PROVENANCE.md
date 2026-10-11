# Source provenance

Yocto/GL source is copied without changes from
https://github.com/xelatihy/yocto-gl at revision
`7e35c631b5ee29f1a7ee1010c5dcf0879aa3dcf3`.

The fixture includes math, color, geometry, noise, sampling, shading, shape,
image, scene, BVH and trace modules. `yocto_modelio.h` is retained because the
shape implementation includes it; no model importer implementation is linked.
Original source files retain their copyright and MIT notices. `LICENSE-YOCTO`
contains the same notice for generated comment-free code.

`support/stb_image/stb_image_resize.h` and its LICENSE come from
`exts/stb_image/stb_image/` in the same upstream revision. We use its MIT option.
The generator includes both declarations and implementation in the monolith;
there is no separately linked renderer or vendor dependency in the final payload.

`main.cpp` and `support/stb.cpp` are benchmark-owned fixture drivers under
`LICENSE-BENCHMARK`. Scenes are generated in code. There are no external models,
textures, graphics drivers or optional accelerators.

Generation prepares a comment-free copy, then packs and optionally renames it.
The inverse returns that prepared project, not the original commented source.
Licenses and this provenance file are copied to the output's separate `notices/`
directory, outside the agent workspace. Keep them when distributing generated code.
