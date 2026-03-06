"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const puppeteer_core_1 = __importStar(require("puppeteer-core"));
const BROWSER_ENDPOINT = "http://localhost:9222";
class BrowserProgressiveServer {
    server;
    browser = null;
    constructor() {
        this.server = new index_js_1.Server({
            name: "browser-progressive-mcp",
            version: "1.0.0",
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.setupTools();
    }
    async getBrowser() {
        if (!this.browser) {
            try {
                this.browser = await puppeteer_core_1.default.connect({
                    browserURL: BROWSER_ENDPOINT,
                    defaultViewport: null,
                });
            }
            catch (error) {
                throw new Error("Failed to connect to Brave/Chrome on 9222. Please start it with --remote-debugging-port=9222");
            }
        }
        return this.browser;
    }
    setupTools() {
        this.server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
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
        this.server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const browser = await this.getBrowser();
            switch (name) {
                case "list_tabs": {
                    const pages = await browser.pages();
                    const list = pages.map((p, i) => `[${i}] ${p.url()}`).join("\n");
                    return { content: [{ type: "text", text: list || "No tabs open" }] };
                }
                case "add_tab": {
                    const { url } = args;
                    const page = await browser.newPage();
                    await page.goto(url, { waitUntil: "domcontentloaded" });
                    return { content: [{ type: "text", text: `Opened ${url}` }] };
                }
                case "list_elements": {
                    const { tabId, nodeId } = args;
                    const pages = await browser.pages();
                    const page = pages[parseInt(tabId)];
                    if (!page)
                        throw new Error("Tab not found");
                    const client = await page.target().createCDPSession();
                    await client.send("Accessibility.enable");
                    const { nodes } = await client.send("Accessibility.getFullAXTree");
                    const result = this.formatAXTree(nodes, nodeId);
                    return { content: [{ type: "text", text: result }] };
                }
                case "interact": {
                    const { tabId, nodeId, action, value } = args;
                    const pages = await browser.pages();
                    const page = pages[parseInt(tabId)];
                    if (!page)
                        throw new Error("Tab not found");
                    const client = await page.target().createCDPSession();
                    // 通过 nodeId 获取 backendNodeId
                    await client.send("Accessibility.enable");
                    const { nodes } = await client.send("Accessibility.getFullAXTree");
                    const node = nodes.find(n => n.nodeId === nodeId);
                    if (!node || !node.backendDOMNodeId)
                        throw new Error("Node or Backend ID not found");
                    // 将 backendNodeId 映射到 RemoteObject
                    const { object } = await client.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
                    if (action === "click") {
                        await page.evaluate((el) => el.click(), object);
                    }
                    else if (action === "type") {
                        await page.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, object, value || "");
                    }
                    else if (action === "hover") {
                        await page.evaluate((el) => { el.scrollIntoView(); }, object);
                    }
                    return { content: [{ type: "text", text: `Success: ${action} on ${nodeId}` }] };
                }
                default:
                    throw new Error("Unknown tool");
            }
        });
    }
    formatAXTree(nodes, targetNodeId) {
        const nodeMap = new Map(nodes.map(n => [n.nodeId, n]));
        const root = nodes.find(n => n.role.value === "RootWebArea");
        if (!root)
            return "No RootWebArea found";
        const output = [];
        const printNode = (nodeId, depth) => {
            const node = nodeMap.get(nodeId);
            if (!node)
                return;
            const role = node.role?.value || "unknown";
            const name = node.name?.value || "";
            const hasChildren = (node.childIds || []).length > 0;
            const indent = "  ".repeat(depth);
            const childPrefix = hasChildren ? "[+]" : "   ";
            // 过滤：只有根、交互元素或有名字的元素才显示
            const isInteractive = ["button", "link", "textbox", "checkbox", "combobox", "listbox", "menuitem"].includes(role);
            const isHeading = role === "heading";
            if (nodeId === root.nodeId || isInteractive || isHeading || (name && name.length > 1)) {
                output.push(`${indent}${childPrefix} ID: ${nodeId} | [${role}] ${name}`);
            }
            // 如果是目标节点，展开其子节点；如果是根节点，展开第一层
            if (nodeId === targetNodeId || (nodeId === root.nodeId && !targetNodeId)) {
                for (const childId of (node.childIds || [])) {
                    printNode(childId, depth + 1);
                }
            }
        };
        printNode(targetNodeId || root.nodeId, 0);
        return output.join("\n");
    }
    async run() {
        const transport = new stdio_js_1.StdioServerTransport();
        await this.server.connect(transport);
        console.error("Browser Progressive MCP Server running...");
    }
}
const server = new BrowserProgressiveServer();
server.run().catch(console.error);
//# sourceMappingURL=index.js.map