import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test.each([
  { channel: "dev", target: "aarch64-apple-darwin", build: "opencode-darwin-arm64", cli: "dev" },
  { channel: "beta", target: "x86_64-apple-darwin", build: "opencode-darwin-x64-baseline", cli: "beta" },
  { channel: "prod", target: "aarch64-pc-windows-msvc", build: "opencode-windows-arm64", cli: "latest" },
  { channel: "latest", target: "x86_64-pc-windows-msvc", build: "opencode-windows-x64-baseline", cli: "latest" },
  { channel: "", target: "aarch64-unknown-linux-gnu", build: "opencode-linux-arm64", cli: "dev" },
  { channel: "local", target: "x86_64-unknown-linux-gnu", build: "opencode-linux-x64-baseline", cli: "dev" },
  { channel: "other", target: "aarch64-unknown-linux-gnu", build: "opencode-linux-arm64", cli: "dev" },
  {
    channel: "prod",
    target: "aarch64-apple-darwin",
    build: "opencode-darwin-arm64",
    cli: "latest",
    version: "1.2.3-custom",
  },
])("builds the checkout CLI for $channel / $target", async (entry) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-desktop-prebuild-")))
  try {
    const desktop = path.join(directory, "packages/desktop")
    await mkdir(path.join(desktop, "resources"), { recursive: true })
    await Promise.all([
      ...["prebuild.ts", "utils.ts", "copy-icons.ts", "copy-metainfo.ts"].map((file) =>
        Bun.write(path.join(desktop, "scripts", file), Bun.file(path.join(import.meta.dirname, file))),
      ),
      Bun.write(path.join(directory, "packages/cli/package.json"), JSON.stringify({ version: "9.8.7-fixture" })),
      Bun.write(
        path.join(directory, "packages/cli/script/build.ts"),
        Bun.file(path.join(import.meta.dirname, "fixtures/cli-build-failure.ts")),
      ),
      cp(path.join(import.meta.dirname, "../icons"), path.join(desktop, "icons"), { recursive: true }),
      symlink(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(desktop, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      ),
    ])
    const child = Bun.spawn([process.execPath, "scripts/prebuild.ts"], {
      cwd: desktop,
      env: {
        ...process.env,
        OPENCODE_CHANNEL: entry.channel,
        OPENCODE_CLI_TARGET: entry.target,
        OPENCODE_CLI_DIST: "",
        OPENCODE_VERSION: entry.version ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).not.toBe(0)
    const request = output.split("\n").find((line) => line.startsWith("cli-build-request:"))
    expect(request, error).toBeDefined()
    if (!request) throw new Error(error)
    expect(JSON.parse(request.slice("cli-build-request:".length))).toEqual({
      args: [`--target=${entry.build}`, `--outdir=${path.join(desktop, ".cache/cli")}`],
      channel: entry.cli,
      version: entry.version ?? (entry.cli === "latest" ? "9.8.7-fixture" : ""),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
