import path from "node:path"
import { discoverPluginRuntimeSpecifiers, pluginRuntimeLoaderCode } from "@opencode/plugin/runtime-modules"
import { resolveOpencodePty } from "./opencode-pty"
import pkg from "../package.json"

// Package the same native assets and plugin imports as the regular CLI build.
const pty = await resolveOpencodePty({ platform: process.platform, arch: process.arch })
const modules = discoverPluginRuntimeSpecifiers()
const result = await Bun.build({
  entrypoints: [path.resolve(import.meta.dirname, "../src/mcp/standalone.ts")],
  target: "bun",
  format: "esm",
  minify: true,
  env: "disable",
  external: ["node-gyp"],
  compile: {
    outfile: path.resolve(import.meta.dirname, "../dist/opencode-mcp"),
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  define: {
    OPENCODE_VERSION: JSON.stringify(pkg.version),
    OPENCODE_CHANNEL: '"local"',
    OPENCODE_ARTIFACT: '"mcp"',
    OPENCODE_LIBC: process.platform === "linux" ? '"glibc"' : "undefined",
    FFF_LIBC: '"gnu"',
  },
  plugins: [
    {
      name: "opencode-mcp-runtime",
      setup(build) {
        build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
          loader: "js",
          contents: pty
            ? `import file from ${JSON.stringify(pty.source)} with { type: "file" }; export default { path: file, version: ${JSON.stringify(pty.version)}, sha256: ${JSON.stringify(pty.sha256)} }`
            : "export default undefined",
        }))
        build.onLoad({ filter: /filesystem[/\\]watcher-binding\.ts$/ }, () => ({
          loader: "js",
          contents: `export default () => require(${JSON.stringify(`@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`)})`,
        }))
        build.onLoad({ filter: /plugin[/\\]src[/\\]runtime-modules\.ts$/ }, () => ({
          loader: "ts",
          contents: [
            "export const resolveHostPackageRoots = () => []",
            "export const loadRuntimeModules = () => ({",
            ...Array.from(
              modules.keys(),
              (specifier) => `${JSON.stringify(specifier)}: ${pluginRuntimeLoaderCode(specifier, modules)},`,
            ),
            "})",
          ].join("\n"),
        }))
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, "Unable to build OpenCode MCP")
console.log("Built dist/opencode-mcp")
