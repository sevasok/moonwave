import { createRequire } from "module"
import yargs from "yargs"
import buildCommand from "./commands/build.js"
import devCommand from "./commands/dev.js"
import deployMcpCommand from "./commands/deploy-mcp.js"
import extractGitHubCommand from "./commands/extract-github.js"

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
  "include-raw": string[]
  "include-github": string[]
  "extract-github": string[]
  config: string
  repo: string
  branch: string
  output: string
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
        .describe("url", "URL of the primary Moonwave documentation site")
      yargs
        .array("include-raw")
        .string("include-raw")
        .describe("include-raw", "Additional raw.json URLs to include (can be repeated)")
      yargs
        .array("include-github")
        .string("include-github")
        .describe("include-github", "GitHub repos with Moonwave docs, e.g. 'owner/repo' (can be repeated)")
      yargs
        .array("extract-github")
        .string("extract-github")
        .describe("extract-github", "GitHub repos to extract docs from at deploy time (for repos without raw.json)")
      yargs
        .string("config")
        .describe("config", "Path to moonwave-mcp.json config file")
    },
    deployMcpCommand
  )
  .command<Args>(
    "extract-github",
    "extract raw.json documentation from a GitHub repository",
    (yargs) => {
      yargs
        .string("repo")
        .describe("repo", "GitHub repository (owner/repo) or full URL")
        .demandOption("repo")
      yargs
        .string("branch")
        .describe("branch", "Git branch to clone")
        .default("branch", "main")
      yargs
        .array("code")
        .string("code")
        .describe("code", "Paths to Lua source code (auto-detected if not specified)")
      yargs
        .string("output")
        .alias("o", "output")
        .describe("output", "Output file path (prints to stdout if not specified)")
    },
    extractGitHubCommand
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
