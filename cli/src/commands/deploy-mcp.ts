import { execSync } from "child_process"
import fs from "fs-extra"
import path from "path"

interface DeployMcpArgs {
  "account-id": string
  "api-token": string
  url: string
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
      return new Response(JSON.stringify({
        name: 'moonwave-mcp-server',
        version: '1.0.0',
        description: 'MCP server for Moonwave API documentation',
        protocolVersion: '2025-03-26',
        docsUrl: env.DOCS_URL,
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
              name: 'get_raw_api_data',
              description: 'Get the complete raw API documentation data',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'search_classes',
              description: 'Search for classes by name or tag',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query for class name' },
                  tag: { type: 'string', description: 'Filter by tag' }
                }
              }
            },
            {
              name: 'get_class',
              description: 'Get detailed information about a specific class',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'The class name' }
                },
                required: ['name']
              }
            },
            {
              name: 'search_functions',
              description: 'Search for functions across all classes',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query for function name' },
                  className: { type: 'string', description: 'Filter by class name' }
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
                  functionName: { type: 'string', description: 'The function name' }
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
      
      // Fetch raw API data
      const apiUrl = new URL('/raw', env.DOCS_URL);
      const response = await fetch(apiUrl.toString());
      const rawData = await response.json();
      
      let content;
      
      switch (name) {
        case 'get_raw_api_data':
          content = [{ type: 'text', text: JSON.stringify(rawData, null, 2) }];
          break;
          
        case 'search_classes':
          const filteredClasses = rawData.filter(cls => {
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
              description: c.desc 
            })), null, 2) 
          }];
          break;
          
        case 'get_class':
          const classData = rawData.find(cls => cls.name === args.name);
          if (!classData) {
            content = [{ type: 'text', text: \`Class '\${args.name}' not found\` }];
          } else {
            content = [{ type: 'text', text: JSON.stringify(classData, null, 2) }];
          }
          break;
          
        case 'search_functions':
          const functions = [];
          for (const cls of rawData) {
            if (args.className && cls.name !== args.className) continue;
            for (const func of cls.functions || []) {
              if (!args.query || func.name.toLowerCase().includes(args.query.toLowerCase())) {
                functions.push({
                  className: cls.name,
                  name: func.name,
                  type: func.function_type,
                  description: func.desc
                });
              }
            }
          }
          content = [{ type: 'text', text: JSON.stringify(functions, null, 2) }];
          break;
          
        case 'get_function':
          const targetClass = rawData.find(cls => cls.name === args.className);
          if (!targetClass) {
            content = [{ type: 'text', text: \`Class '\${args.className}' not found\` }];
          } else {
            const func = targetClass.functions?.find(f => f.name === args.functionName);
            if (!func) {
              content = [{ type: 'text', text: \`Function '\${args.functionName}' not found in class '\${args.className}'\` }];
            } else {
              content = [{ type: 'text', text: JSON.stringify(func, null, 2) }];
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
DOCS_URL = "%%DOCS_URL%%"`

export default async function deployMcpCommand(args: DeployMcpArgs) {
  try {
    console.log("Moonwave: Creating MCP server for deployment...")

    const tempDir = path.join(process.cwd(), ".moonwave-mcp-temp")
    fs.ensureDirSync(tempDir)
    fs.ensureDirSync(path.join(tempDir, "src"))

    // Write the worker code
    fs.writeFileSync(
      path.join(tempDir, "src", "index.js"),
      MCP_SERVER_CODE
    )

    // Write wrangler.toml with the docs URL
    const wranglerConfig = WRANGLER_TOML.replace("%%DOCS_URL%%", args.url)
    fs.writeFileSync(path.join(tempDir, "wrangler.toml"), wranglerConfig)

    console.log(`Moonwave: Deploying MCP server to Cloudflare...`)
    console.log(`Moonwave: Documentation URL: ${args.url}`)

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
