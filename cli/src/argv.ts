import { createRequire } from "module"
import yargs from "yargs"
import buildCommand from "./commands/build.js"
import devCommand from "./commands/dev.js"
import deployMcpCommand from "./commands/deploy-mcp.js"

const require = createRequire(import.meta.url)

const version = require("../package.json").version as string

export interface Args {
  "out-dir": string
  fresh: boolean
  install: boolean
  code: string[]
  publish: boolean
  "account-id": string
  "api-token": string
  url: string
}

const argv = yargs(process.argv.slice(2))
  .scriptName("moonwave")
  .usage("Usage: moonwave [options]")

  .alias("v", "version")
  .version(version)
  .describe("version", "show version information")

  .alias("h", "help")
  .help("help")
  .describe("help", "show help")
  .showHelpOnFail(true)

  .command<Args>(
    "build",
    "build the docs website",
    (yargs) => {
      yargs
        .boolean("publish")
        .describe(
          "publish",
          "publish the built website to your gh-pages branch after building"
        )
      yargs
        .string("out-dir")
        .describe(
          "out-dir",
          "set the build directory to a different path (relative to the current directory)"
        )
    },
    buildCommand
  )
  .command<Args>(
    "dev",
    "run in development live-reload mode",
    (yargs) => {
      yargs
        .boolean("fresh")
        .describe("fresh", "deletes build cache before building")
        .alias("f", "fresh")
    },
    devCommand
  )
  .command<Args>(
    "deploy-mcp",
    "deploy an MCP server to Cloudflare for API access",
    (yargs) => {
      yargs
        .string("account-id")
        .describe("account-id", "Cloudflare account ID")
        .demandOption("account-id")
      yargs
        .string("api-token")
        .describe("api-token", "Cloudflare API token")
        .demandOption("api-token")
      yargs
        .string("url")
        .describe("url", "URL of the Moonwave documentation site")
        .demandOption("url")
    },
    deployMcpCommand
  )

  .array("code")
  .describe("code", "the path to your Lua code. e.g. 'src'")
  .default("code", ["lib", "src"])

  .boolean("install")
  .describe("install", "re-install npm dependencies")
  .alias("i", "install")

  .strictCommands()
  .demandCommand()
  .parse()

export default argv
