import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The CLI shebang is added via a tsup banner (per the publish spec). src/cli.ts
// also carries a leading shebang so `tsx src/cli.ts` works in dev, so strip the
// source-level shebang at load time and let the banner be the single, leading
// one. The banner is scoped to the cli entry only; the library `index.js` stays
// import-clean with no stray shebang.
const stripSourceShebang = {
  name: "strip-source-shebang",
  setup(build: any) {
    build.onLoad({ filter: /cli\.ts$/ }, (args: { path: string }) => ({
      contents: readFileSync(args.path, "utf8").replace(/^#!.*\r?\n/, ""),
      loader: "ts",
    }));
  },
};

// Layered, pi-style: the SDK packages (@josharsh/pixelpi-*) are published
// separately and stay EXTERNAL here; this package depends on them. tsup
// externalizes everything in `dependencies` by default.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
    esbuildPlugins: [stripSourceShebang],
  },
]);
