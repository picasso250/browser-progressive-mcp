import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BACKEND_URL = "http://localhost:3000";

const server = new Server({ name: "browser-proxy", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "list_tabs", description: "List tabs", inputSchema: { type: "object", properties: {} } },
    { name: "add_tab", description: "Add tab", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "list_elements", description: "List elements", inputSchema: { type: "object", properties: { tabId: { type: "string" }, nodeId: { type: "string" } }, required: ["tabId"] } },
    { name: "interact", description: "Interact", inputSchema: { type: "object", properties: { tabId: { type: "string" }, nodeId: { type: "string" }, action: { type: "string" }, value: { type: "string" } }, required: ["tabId", "nodeId", "action"] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let res;
    if (name === "list_tabs") {
      res = await fetch(`${BACKEND_URL}/tabs`);
    } else if (name === "add_tab") {
      res = await fetch(`${BACKEND_URL}/tabs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    } else if (name === "list_elements") {
      const { tabId, nodeId } = args as any;
      res = await fetch(`${BACKEND_URL}/elements/${tabId}${nodeId ? `?nodeId=${nodeId}` : ""}`);
    } else if (name === "interact") {
      const { tabId, ...body } = args as any;
      res = await fetch(`${BACKEND_URL}/interact/${tabId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      throw new Error("Unknown tool");
    }
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Backend error: ${e.message}. Is the server running?` }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
