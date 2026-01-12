import { execSync } from "child_process"
import fs from "fs-extra"
import path from "path"
import os from "os"
import { getBinaryPath } from "../binary.js"

interface DocSource {
  name: string
  url?: string
  raw?: string
  github?: string
  extract?: boolean  // If true, extract from GitHub instead of using raw.json URL
  _embeddedData?: any[]  // Extracted data embedded at deploy time
}

interface McpConfig {
  sources: DocSource[]
}

interface DeployMcpArgs {
  "account-id": string
  "api-token": string
  url?: string
  "include-raw"?: string[]
  "include-github"?: string[]
  "extract-github"?: string[]  // New: extract from GitHub at deploy time
  config?: string
}

const MCP_SERVER_CODE = `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // MCP endpoint
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
      if (request.method === 'POST') {
        return handlePost(request, env);
      } else if (request.method === 'GET') {
        return handleGet(request, env);
      } else if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: getCorsHeaders(request)
        });
      }
      return new Response('Method Not Allowed', { status: 405 });
    }
    
    // Info endpoint
    if (url.pathname === '/' && request.method === 'GET') {
      const sources = JSON.parse(env.DOC_SOURCES || '[]');
      return new Response(JSON.stringify({
        name: 'moonwave-mcp-server',
        version: '1.0.0',
        description: 'MCP server for Moonwave API documentation',
        protocolVersion: '2025-03-26',
        sources: sources.map(s => ({ name: s.name, url: s.url || s.raw })),
        mcpEndpoint: '/mcp'
      }), {
        headers: { 
          'Content-Type': 'application/json',
          ...getCorsHeaders(request)
        }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID'
  };
}

// Fetch and merge data from all sources
async function fetchAllSources(env) {
  const sources = JSON.parse(env.DOC_SOURCES || '[]');
  const allData = [];
  
  for (const source of sources) {
    try {
      // Check for embedded data first (extracted at deploy time)
      if (source._embeddedData && Array.isArray(source._embeddedData)) {
        for (const cls of source._embeddedData) {
          allData.push({
            ...cls,
            _source: source.name,
            _sourceUrl: source.github || source.url || source.raw
          });
        }
        continue;
      }
      
      let rawUrl = source.raw;
      if (!rawUrl && source.url) {
        const baseUrl = source.url.endsWith('/') ? source.url.slice(0, -1) : source.url;
        rawUrl = \`\${baseUrl}/raw.json\`;
      }
      
      if (!rawUrl) continue;
      
      const response = await fetch(rawUrl);
      if (!response.ok) {
        console.error(\`Failed to fetch \${source.name}: \${response.status}\`);
        continue;
      }
      
      const data = await response.json();
      
      // Add source metadata to each class
      for (const cls of data) {
        allData.push({
          ...cls,
          _source: source.name,
          _sourceUrl: source.url || source.raw
        });
      }
    } catch (e) {
      console.error(\`Error fetching \${source.name}: \${e.message}\`);
    }
  }
  
  return allData;
}

async function handlePost(request, env) {
  const accept = request.headers.get('Accept') || '';
  const sessionId = request.headers.get('Mcp-Session-Id');
  
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' }
    }), { 
      status: 400,
      headers: { 
        'Content-Type': 'application/json',
        ...getCorsHeaders(request)
      }
    });
  }
  
  const messages = Array.isArray(body) ? body : [body];
  const hasRequests = messages.some(msg => msg.method && msg.id !== undefined);
  
  // Handle notifications/responses only
  if (!hasRequests) {
    return new Response(null, { 
      status: 202,
      headers: getCorsHeaders(request)
    });
  }
  
  // Handle requests - use SSE if accepted
  if (accept.includes('text/event-stream')) {
    return handleSSE(messages, sessionId, env, request);
  }
  
  // Single JSON response
  const responses = await Promise.all(
    messages.filter(msg => msg.id !== undefined).map(msg => handleRequest(msg, sessionId, env))
  );
  
  return new Response(JSON.stringify(responses.length === 1 ? responses[0] : responses), {
    headers: { 
      'Content-Type': 'application/json',
      ...getCorsHeaders(request)
    }
  });
}

async function handleGet(request, env) {
  const accept = request.headers.get('Accept') || '';
  
  if (!accept.includes('text/event-stream')) {
    return new Response('Method Not Allowed', { status: 405 });
  }
  
  // Open SSE stream for server-initiated messages
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  // Keep connection alive
  const keepAlive = setInterval(() => {
    writer.write(encoder.encode(': keepalive\\n\\n'));
  }, 30000);
  
  // Close after 5 minutes of inactivity
  setTimeout(() => {
    clearInterval(keepAlive);
    writer.close();
  }, 300000);
  
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...getCorsHeaders(request)
    }
  });
}

async function handleSSE(messages, sessionId, env, request) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  (async () => {
    try {
      for (const msg of messages) {
        if (msg.id !== undefined) {
          const response = await handleRequest(msg, sessionId, env);
          const data = JSON.stringify(response);
          await writer.write(encoder.encode(\`data: \${data}\\n\\n\`));
        }
      }
    } catch (e) {
      const errorResponse = {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error', data: e.message }
      };
      await writer.write(encoder.encode(\`data: \${JSON.stringify(errorResponse)}\\n\\n\`));
    } finally {
      await writer.close();
    }
  })();
  
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...getCorsHeaders(request)
    }
  });
}

async function handleRequest(message, sessionId, env) {
  const { jsonrpc, id, method, params } = message;
  
  try {
    // Handle initialization
    if (method === 'initialize') {
      const newSessionId = crypto.randomUUID();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'moonwave-mcp-server',
            version: '1.0.0'
          }
        },
        _sessionId: newSessionId
      };
    }
    
    // Handle tools/list
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'list_sources',
              description: 'List all documentation sources configured in this MCP server',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'get_raw_api_data',
              description: 'Get the complete raw API documentation data from all sources',
              inputSchema: {
                type: 'object',
                properties: {
                  source: { type: 'string', description: 'Filter by source name (optional)' }
                }
              }
            },
            {
              name: 'search_classes',
              description: 'Search for classes by name or tag across all sources',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query for class name' },
                  tag: { type: 'string', description: 'Filter by tag' },
                  source: { type: 'string', description: 'Filter by source name' }
                }
              }
            },
            {
              name: 'get_class',
              description: 'Get detailed information about a specific class',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'The class name' },
                  source: { type: 'string', description: 'The source name (optional, useful if multiple sources have same class name)' }
                },
                required: ['name']
              }
            },
            {
              name: 'search_functions',
              description: 'Search for functions across all classes and sources',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query for function name' },
                  className: { type: 'string', description: 'Filter by class name' },
                  source: { type: 'string', description: 'Filter by source name' }
                }
              }
            },
            {
              name: 'get_function',
              description: 'Get detailed information about a specific function',
              inputSchema: {
                type: 'object',
                properties: {
                  className: { type: 'string', description: 'The class name' },
                  functionName: { type: 'string', description: 'The function name' },
                  source: { type: 'string', description: 'The source name (optional)' }
                },
                required: ['className', 'functionName']
              }
            }
          ]
        }
      };
    }
    
    // Handle tools/call
    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const sources = JSON.parse(env.DOC_SOURCES || '[]');
      
      // Handle list_sources without fetching data
      if (name === 'list_sources') {
        const sourceInfo = sources.map(s => ({
          name: s.name,
          url: s.url || s.raw
        }));
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(sourceInfo, null, 2) }]
          }
        };
      }
      
      // Fetch all data from all sources
      const rawData = await fetchAllSources(env);
      
      let content;
      
      switch (name) {
        case 'get_raw_api_data':
          let dataToReturn = rawData;
          if (args.source) {
            dataToReturn = rawData.filter(cls => cls._source === args.source);
          }
          content = [{ type: 'text', text: JSON.stringify(dataToReturn, null, 2) }];
          break;
          
        case 'search_classes':
          const filteredClasses = rawData.filter(cls => {
            if (args.source && cls._source !== args.source) {
              return false;
            }
            if (args.query && !cls.name.toLowerCase().includes(args.query.toLowerCase())) {
              return false;
            }
            if (args.tag && (!cls.tags || !cls.tags.includes(args.tag))) {
              return false;
            }
            return true;
          });
          content = [{ 
            type: 'text', 
            text: JSON.stringify(filteredClasses.map(c => ({ 
              name: c.name, 
              tags: c.tags,
              description: c.desc,
              source: c._source
            })), null, 2) 
          }];
          break;
          
        case 'get_class':
          let classData = rawData.filter(cls => cls.name === args.name);
          if (args.source) {
            classData = classData.filter(cls => cls._source === args.source);
          }
          if (classData.length === 0) {
            content = [{ type: 'text', text: \`Class '\${args.name}' not found\` }];
          } else if (classData.length === 1) {
            content = [{ type: 'text', text: JSON.stringify(classData[0], null, 2) }];
          } else {
            // Multiple matches from different sources
            content = [{ 
              type: 'text', 
              text: \`Found \${classData.length} classes named '\${args.name}' from different sources. Specify 'source' parameter to disambiguate.\\n\\n\` +
                JSON.stringify(classData.map(c => ({ name: c.name, source: c._source, desc: c.desc })), null, 2)
            }];
          }
          break;
          
        case 'search_functions':
          const functions = [];
          for (const cls of rawData) {
            if (args.source && cls._source !== args.source) continue;
            if (args.className && cls.name !== args.className) continue;
            for (const func of cls.functions || []) {
              if (!args.query || func.name.toLowerCase().includes(args.query.toLowerCase())) {
                functions.push({
                  className: cls.name,
                  name: func.name,
                  type: func.function_type,
                  description: func.desc,
                  source: cls._source
                });
              }
            }
          }
          content = [{ type: 'text', text: JSON.stringify(functions, null, 2) }];
          break;
          
        case 'get_function':
          let targetClasses = rawData.filter(cls => cls.name === args.className);
          if (args.source) {
            targetClasses = targetClasses.filter(cls => cls._source === args.source);
          }
          
          if (targetClasses.length === 0) {
            content = [{ type: 'text', text: \`Class '\${args.className}' not found\` }];
          } else {
            const foundFunctions = [];
            for (const targetClass of targetClasses) {
              const func = targetClass.functions?.find(f => f.name === args.functionName);
              if (func) {
                foundFunctions.push({ ...func, _source: targetClass._source, _className: targetClass.name });
              }
            }
            
            if (foundFunctions.length === 0) {
              content = [{ type: 'text', text: \`Function '\${args.functionName}' not found in class '\${args.className}'\` }];
            } else if (foundFunctions.length === 1) {
              content = [{ type: 'text', text: JSON.stringify(foundFunctions[0], null, 2) }];
            } else {
              content = [{ type: 'text', text: JSON.stringify(foundFunctions, null, 2) }];
            }
          }
          break;
          
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: \`Unknown tool: \${name}\` }
          };
      }
      
      return {
        jsonrpc: '2.0',
        id,
        result: { content }
      };
    }
    
    // Method not found
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' }
    };
    
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Internal error', data: e.message }
    };
  }
}`

const WRANGLER_TOML = `name = "moonwave-mcp-server"
main = "src/index.js"
compatibility_date = "2024-12-01"

[vars]
DOC_SOURCES = '%%DOC_SOURCES%%'`

function extractNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Try to get a meaningful name from the hostname/path
    const hostname = parsed.hostname.replace(/^www\./, '')
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    
    if (hostname.includes('github.io')) {
      // e.g., "username.github.io/project" -> "project"
      return pathParts[0] || hostname.split('.')[0]
    }
    
    // Use hostname without TLD
    return hostname.split('.')[0]
  } catch {
    return url
  }
}

function resolveGitHubUrl(repo: string): string {
  // Convert "owner/repo" to GitHub Pages URL
  const [owner, repoName] = repo.split('/')
  return `https://${owner}.github.io/${repoName}/raw.json`
}

async function extractFromGitHub(repo: string, binaryPath: string): Promise<any[] | null> {
  console.log(`Moonwave: Extracting documentation from ${repo}...`)
  
  const tempDir = path.join(os.tmpdir(), `moonwave-extract-${Date.now()}`)
  fs.ensureDirSync(tempDir)
  
  try {
    // Clone the repository
    const repoUrl = repo.includes("://") ? repo : `https://github.com/${repo}.git`
    
    try {
      execSync(`git clone --depth 1 --branch main "${repoUrl}" "${tempDir}"`, {
        stdio: "pipe",
      })
    } catch {
      // Try without branch if main doesn't exist
      execSync(`git clone --depth 1 "${repoUrl}" "${tempDir}"`, {
        stdio: "pipe",
      })
    }
    
    // Find code paths from moonwave.toml or auto-detect
    let codePaths: string[] = []
    
    const tomlPath = path.join(tempDir, "moonwave.toml")
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, "utf-8")
      const codeMatch = content.match(/code\s*=\s*\[(.*?)\]/s)
      if (codeMatch) {
        codePaths = codeMatch[1]
          .split(",")
          .map(s => s.trim().replace(/['"]/g, ""))
          .filter(Boolean)
      }
    }
    
    if (codePaths.length === 0) {
      // Auto-detect
      const candidates = ["src", "lib", "Source", "Lib", "Packages", "packages"]
      for (const candidate of candidates) {
        if (fs.existsSync(path.join(tempDir, candidate))) {
          codePaths.push(candidate)
        }
      }
    }
    
    if (codePaths.length === 0) {
      codePaths = ["."]
    }
    
    // Extract
    const results: any[] = []
    
    for (const codePath of codePaths) {
      const fullPath = path.join(tempDir, codePath)
      if (!fs.existsSync(fullPath)) continue
      
      try {
        const result = execSync(
          `"${binaryPath}" extract "${fullPath.replace(/\\/g, "/")}" --base "${tempDir.replace(/\\/g, "/")}"`,
          {
            maxBuffer: 50 * 1024 * 1024,
            encoding: "utf-8",
          }
        )
        
        const parsed = JSON.parse(result)
        results.push(...(Array.isArray(parsed) ? parsed : [parsed]))
      } catch (e) {
        console.warn(`Moonwave: Warning - failed to extract from ${codePath}`)
      }
    }
    
    console.log(`Moonwave: Extracted ${results.length} classes from ${repo}`)
    return results.length > 0 ? results : null
    
  } catch (e) {
    console.error(`Moonwave: Failed to extract from ${repo}: ${e}`)
    return null
  } finally {
    try {
      fs.removeSync(tempDir)
    } catch {}
  }
}

function loadConfigFile(configPath: string): McpConfig | null {
  try {
    const absolutePath = path.isAbsolute(configPath) 
      ? configPath 
      : path.join(process.cwd(), configPath)
    
    if (!fs.existsSync(absolutePath)) {
      console.error(`Moonwave: Config file not found: ${absolutePath}`)
      return null
    }
    
    const content = fs.readFileSync(absolutePath, 'utf-8')
    return JSON.parse(content) as McpConfig
  } catch (e) {
    console.error(`Moonwave: Failed to parse config file: ${e}`)
    return null
  }
}

async function buildSourcesList(args: DeployMcpArgs, binaryPath: string): Promise<DocSource[]> {
  const sources: DocSource[] = []
  
  // Check for config file first
  if (args.config) {
    const config = loadConfigFile(args.config)
    if (config?.sources) {
      // Process config sources, resolving github shortcuts
      for (const source of config.sources) {
        if (source.github) {
          if (source.extract) {
            // Extract at deploy time
            const extractedData = await extractFromGitHub(source.github, binaryPath)
            if (extractedData) {
              sources.push({
                name: source.name || source.github.split('/')[1],
                github: source.github,
                _embeddedData: extractedData
              })
            }
          } else {
            sources.push({
              name: source.name || source.github.split('/')[1],
              raw: resolveGitHubUrl(source.github)
            })
          }
        } else {
          sources.push(source)
        }
      }
    }
  }
  
  // Add primary URL if provided
  if (args.url) {
    sources.push({
      name: extractNameFromUrl(args.url),
      url: args.url
    })
  }
  
  // Add --include-raw URLs
  if (args["include-raw"]) {
    for (const rawUrl of args["include-raw"]) {
      sources.push({
        name: extractNameFromUrl(rawUrl),
        raw: rawUrl
      })
    }
  }
  
  // Add --include-github repos (assumes raw.json exists)
  if (args["include-github"]) {
    for (const repo of args["include-github"]) {
      const [, repoName] = repo.split('/')
      sources.push({
        name: repoName || repo,
        raw: resolveGitHubUrl(repo)
      })
    }
  }
  
  // Add --extract-github repos (extracts at deploy time)
  if (args["extract-github"]) {
    for (const repo of args["extract-github"]) {
      const [, repoName] = repo.split('/')
      const extractedData = await extractFromGitHub(repo, binaryPath)
      if (extractedData) {
        sources.push({
          name: repoName || repo,
          github: repo,
          _embeddedData: extractedData
        })
      }
    }
  }
  
  return sources
}

export default async function deployMcpCommand(args: DeployMcpArgs) {
  try {
    console.log("Moonwave: Creating MCP server for deployment...")

    // Get the binary path for extraction
    const binaryPath = await getBinaryPath()

    // Build the sources list from config and/or CLI args
    const sources = await buildSourcesList(args, binaryPath)
    
    if (sources.length === 0) {
      console.error("Moonwave: No documentation sources provided.")
      console.error("Moonwave: Use --url, --include-raw, --include-github, --extract-github, or --config to specify sources.")
      process.exit(1)
    }

    const tempDir = path.join(process.cwd(), ".moonwave-mcp-temp")
    fs.ensureDirSync(tempDir)
    fs.ensureDirSync(path.join(tempDir, "src"))

    // Write the worker code
    fs.writeFileSync(
      path.join(tempDir, "src", "index.js"),
      MCP_SERVER_CODE
    )

    // Write wrangler.toml with the sources as JSON
    const sourcesJson = JSON.stringify(sources).replace(/'/g, "\\'")
    const wranglerConfig = WRANGLER_TOML.replace("%%DOC_SOURCES%%", sourcesJson)
    fs.writeFileSync(path.join(tempDir, "wrangler.toml"), wranglerConfig)

    console.log(`Moonwave: Deploying MCP server to Cloudflare...`)
    console.log(`Moonwave: Documentation sources:`)
    for (const source of sources) {
      const embeddedCount = source._embeddedData ? ` (${source._embeddedData.length} classes embedded)` : ''
      console.log(`  - ${source.name}: ${source.url || source.raw || source.github}${embeddedCount}`)
    }

    // Deploy using Wrangler
    const deployCommand = `npx wrangler@latest deploy --compatibility-date=2024-12-01`
    const env = {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: args["account-id"],
      CLOUDFLARE_API_TOKEN: args["api-token"],
    }

    execSync(deployCommand, {
      cwd: tempDir,
      stdio: "inherit",
      env,
    })

    console.log("Moonwave: MCP server deployed successfully!")
    console.log(
      "Moonwave: Your MCP server is now available and connected to your Moonwave documentation."
    )

    // Clean up temp directory
    fs.removeSync(tempDir)
  } catch (e) {
    console.error(typeof e === "object" && e !== null ? e.toString() : e)
    console.error(
      "Moonwave: It looks like something went wrong. Check the error output above."
    )
    process.exit(1)
  }
}
