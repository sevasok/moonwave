import { execSync } from "child_process"
import fs from "fs-extra"
import path from "path"
import os from "os"
import { getBinaryPath } from "../binary.js"

interface ExtractGitHubArgs {
  repo: string
  branch?: string
  code?: string[]
  output?: string
}

async function findMoonwaveConfig(dir: string): Promise<{ code: string[] } | null> {
  const tomlPath = path.join(dir, "moonwave.toml")
  
  if (fs.existsSync(tomlPath)) {
    try {
      const content = fs.readFileSync(tomlPath, "utf-8")
      // Simple TOML parsing for code paths
      const codeMatch = content.match(/code\s*=\s*\[(.*?)\]/s)
      if (codeMatch) {
        const paths = codeMatch[1]
          .split(",")
          .map(s => s.trim().replace(/['"]/g, ""))
          .filter(Boolean)
        return { code: paths }
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }
  
  return null
}

async function findLuaDirectories(dir: string): Promise<string[]> {
  const candidates = ["src", "lib", "Source", "Lib", "Packages", "packages"]
  const found: string[] = []
  
  for (const candidate of candidates) {
    const candidatePath = path.join(dir, candidate)
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      found.push(candidate)
    }
  }
  
  return found.length > 0 ? found : ["."]
}

export default async function extractGitHubCommand(args: ExtractGitHubArgs) {
  const { repo, branch = "main", output } = args
  
  console.log(`Moonwave: Extracting documentation from GitHub repo: ${repo}`)
  
  // Get the binary path
  const binaryPath = await getBinaryPath()
  console.log(`Moonwave: Using extractor at: ${binaryPath}`)
  
  // Create temp directory
  const tempDir = path.join(os.tmpdir(), `moonwave-extract-${Date.now()}`)
  fs.ensureDirSync(tempDir)
  
  try {
    // Clone the repository
    console.log(`Moonwave: Cloning ${repo}...`)
    const repoUrl = repo.includes("://") ? repo : `https://github.com/${repo}.git`
    
    try {
      execSync(`git clone --depth 1 --branch ${branch} "${repoUrl}" "${tempDir}"`, {
        stdio: "pipe",
      })
    } catch (e) {
      // Try without branch if main doesn't exist
      console.log(`Moonwave: Branch '${branch}' not found, trying default branch...`)
      execSync(`git clone --depth 1 "${repoUrl}" "${tempDir}"`, {
        stdio: "pipe",
      })
    }
    
    console.log(`Moonwave: Repository cloned successfully`)
    
    // Determine code paths
    let codePaths = args.code
    
    if (!codePaths || codePaths.length === 0) {
      // Try to read from moonwave.toml
      const config = await findMoonwaveConfig(tempDir)
      if (config) {
        codePaths = config.code
        console.log(`Moonwave: Found code paths in moonwave.toml: ${codePaths.join(", ")}`)
      } else {
        // Auto-detect common directories
        codePaths = await findLuaDirectories(tempDir)
        console.log(`Moonwave: Auto-detected code paths: ${codePaths.join(", ")}`)
      }
    }
    
    // Run the extractor
    console.log(`Moonwave: Extracting documentation...`)
    
    const results: any[] = []
    
    for (const codePath of codePaths) {
      const fullPath = path.join(tempDir, codePath)
      
      if (!fs.existsSync(fullPath)) {
        console.warn(`Moonwave: Path not found, skipping: ${codePath}`)
        continue
      }
      
      try {
        const result = execSync(
          `"${binaryPath}" extract "${fullPath.replace(/\\/g, "/")}" --base "${tempDir.replace(/\\/g, "/")}"`,
          {
            maxBuffer: 10 * 1024 * 1024,
            encoding: "utf-8",
          }
        )
        
        const parsed = JSON.parse(result)
        results.push(...(Array.isArray(parsed) ? parsed : [parsed]))
      } catch (e) {
        console.warn(`Moonwave: Failed to extract from ${codePath}: ${e}`)
      }
    }
    
    if (results.length === 0) {
      console.error("Moonwave: No documentation found in the repository")
      process.exit(1)
    }
    
    // Sort by name
    results.sort((a, b) => a.name.localeCompare(b.name))
    
    // Output the results
    const jsonOutput = JSON.stringify(results, null, 2)
    
    if (output) {
      const outputPath = path.isAbsolute(output) ? output : path.join(process.cwd(), output)
      fs.writeFileSync(outputPath, jsonOutput)
      console.log(`Moonwave: Written ${results.length} classes to ${outputPath}`)
    } else {
      // Write to stdout
      console.log(jsonOutput)
    }
    
    console.log(`Moonwave: Extracted ${results.length} classes from ${repo}`)
    
  } catch (e) {
    console.error(`Moonwave: Failed to extract from GitHub: ${e}`)
    process.exit(1)
  } finally {
    // Clean up
    try {
      fs.removeSync(tempDir)
    } catch {
      // Ignore cleanup errors
    }
  }
}
