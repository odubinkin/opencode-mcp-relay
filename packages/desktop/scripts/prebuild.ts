#!/usr/bin/env bun
import { $ } from "bun"
import { join } from "node:path"
import pkg from "../../cli/package.json"

import { copyBuiltCliToResources, getCurrentCli, resolveChannel } from "./utils"

const channel = resolveChannel()
const distribution = Bun.env.OPENCODE_CLI_DIST || join(import.meta.dirname, "../.cache/cli")

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (!Bun.env.OPENCODE_CLI_DIST) {
  const target = getCurrentCli().package.replace("@opencode/cli-", "opencode-")
  await $`bun run script/build.ts --target=${target} --outdir=${distribution}`
    .cwd(join(import.meta.dirname, "../../cli"))
    .env({
      ...process.env,
      // The desktop's prod channel is called latest by the CLI.
      OPENCODE_CHANNEL: channel === "prod" ? "latest" : channel,
      ...(channel === "prod" && !Bun.env.OPENCODE_VERSION ? { OPENCODE_VERSION: pkg.version } : {}),
    })
}

await copyBuiltCliToResources(distribution)
