console.log(
  "cli-build-request:" +
    JSON.stringify({
      args: process.argv.slice(2),
      channel: process.env.OPENCODE_CHANNEL,
      version: process.env.OPENCODE_VERSION,
    }),
)
// Stop after recording the build request: compilation itself is covered by the real build smoke check.
process.exit(23)
