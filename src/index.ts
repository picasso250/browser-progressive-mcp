import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Page } from "puppeteer-core";

const BROWSER_ENDPOINT = "http://localhost:9222";

class BrowserProgressiveServer {
  private server: Server;
  private browser: Browser | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "browser-progressive-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupTools();
  }

  private async getBrowser() {
    if (!this.browser) {
      try {
        this.browser = await puppeteer.connect({
          browserURL: BROWSER_ENDPOINT,
          defaultViewport: null,
        });
      } catch (error) {
        throw new Error("Failed to connect to Brave/Chrome on 9222. Please start it with --remote-debugging-port=9222");
      }
    }
    return this.browser;
  }

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_tabs",
          description: "List all open browser tabs",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "add_tab",
          description: "Open a new tab with a URL",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to open" },
            },
            required: ["url"],
          },
        },
        {
          name: "list_elements",
          description: "List elements of a tab for progressive disclosure",
          inputSchema: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "The ID of the tab (index 0, 1...)" },
              nodeId: { type: "string", description: "The ID of the element to expand (optional)" },
            },
            required: ["tabId"],
          },
        },
        {
          name: "interact",
          description: "Interact with an element (click, type, etc.)",
          inputSchema: {
            type: "object",
            properties: {
              tabId: { type: "string" },
              nodeId: { type: "string" },
              action: { type: "string", enum: ["click", "type", "hover"] },
              value: { type: "string", description: "Value for 'type' action" },
            },
            required: ["tabId", "nodeId", "action"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const browser = await this.getBrowser();

      switch (name) {
        case "list_tabs": {
          const pages = await browser.pages();
          const list = pages.map((p, i) => `[v2][${i}] ${p.url()}`).join("\n");
          return { content: [{ type: "text", text: list || "No tabs open" }] };
        }

        case "add_tab": {
          const { url } = args as { url: string };
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "domcontentloaded" });
          return { content: [{ type: "text", text: `Opened ${url}` }] };
        }

        case "list_elements": {
          const { tabId, nodeId } = args as { tabId: string; nodeId?: string };
          const pages = await browser.pages();
          const page = pages[parseInt(tabId)];
          if (!page) throw new Error("Tab not found");

          const client = await page.target().createCDPSession();
          await client.send("Accessibility.enable");
          const { nodes } = await client.send("Accessibility.getFullAXTree");

          const result = this.formatAXTree(nodes, nodeId);
          return { content: [{ type: "text", text: result }] };
        }

        case "interact": {
          const { tabId, nodeId, action, value } = args as { tabId: string; nodeId: string; action: string; value?: string };
          const pages = await browser.pages();
          const page = pages[parseInt(tabId)];
          if (!page) throw new Error("Tab not found");

          const client = await page.target().createCDPSession();
          // 通过 nodeId 获取 backendNodeId
          await client.send("Accessibility.enable");
          const { nodes } = await client.send("Accessibility.getFullAXTree");
          const node = nodes.find(n => n.nodeId === nodeId);
          if (!node || !node.backendDOMNodeId) throw new Error("Node or Backend ID not found");

          // 将 backendNodeId 映射到 RemoteObject
          const { object } = await client.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
          
          if (action === "click") {
            await page.evaluate((el: any) => el.click(), object);
          } else if (action === "type") {
            await page.evaluate((el: any, val: string) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, object, value || "");
          } else if (action === "hover") {
            await page.evaluate((el: any) => { el.scrollIntoView(); }, object);
          }

          return { content: [{ type: "text", text: `Success: ${action} on ${nodeId}` }] };
        }

        default:
          throw new Error("Unknown tool");
      }
    });
  }

  private formatAXTree(nodes: any[], targetNodeId?: string): string {
    const nodeMap = new Map(nodes.map(n => [n.nodeId, n]));
    const root = nodes.find(n => n.role.value === "RootWebArea");
    if (!root) return "No RootWebArea found";

    const output: string[] = [];

    const printNode = (nodeId: string, depth: number) => {
      const node = nodeMap.get(nodeId);
      if (!node) return;

      const role = node.role?.value || "unknown";
      const name = node.name?.value || "";
      const hasChildren = (node.childIds || []).length > 0;

      // 只有根、交互元素、标题或有名字的元素才显示
      const isInteractive = ["button", "link", "textbox", "checkbox", "combobox", "listbox", "menuitem", "tab"].includes(role);
      const isHeading = role === "heading";
      const isImportantContainer = ["navigation", "main", "complementary", "banner"].includes(role);
      const isGeneric = role === "generic";

      if (nodeId === root.nodeId || isInteractive || isHeading || isImportantContainer || (name && name.length > 1)) {
          const indent = "  ".repeat(depth);
          const childPrefix = hasChildren ? "[+]" : "   ";
          output.push(`${indent}${childPrefix} ID: ${nodeId} | [${role}] ${name}`);
          
          // 如果是显示出来的节点，则深度 +1
          const maxDepth = targetNodeId ? depth + 1 : 2; 
          if (depth < maxDepth) {
            for (const childId of (node.childIds || [])) {
              printNode(childId, depth + 1);
            }
          }
      } else {
          // 如果是不可见的通用容器，则继续遍历其子节点，但不增加深度
          for (const childId of (node.childIds || [])) {
            printNode(childId, depth);
          }
      }
    };

    printNode(targetNodeId || root.nodeId, 0);
    return output.join("\n");
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Browser Progressive MCP Server running...");
  }
}

const server = new BrowserProgressiveServer();
server.run().catch(console.error);
