import express from "express";
import puppeteer, { Browser } from "puppeteer-core";

const app = express();
app.use(express.json());

const BROWSER_ENDPOINT = "http://localhost:9222";
let browser: Browser | null = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.connect({
      browserURL: BROWSER_ENDPOINT,
      defaultViewport: null,
    });
  }
  return browser;
}

// 核心逻辑：渐进式披露 AXTree
function formatAXTree(nodes: any[], targetNodeId?: string) {
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

    const isInteractive = ["button", "link", "textbox", "checkbox", "combobox", "listbox", "menuitem", "tab"].includes(role);
    const isHeading = role === "heading";
    const isImportantContainer = ["navigation", "main", "complementary", "banner"].includes(role);

    if (nodeId === root.nodeId || isInteractive || isHeading || isImportantContainer || (name && name.length > 1)) {
        const indent = "  ".repeat(depth);
        const childPrefix = hasChildren ? "[+]" : "   ";
        output.push(`${indent}${childPrefix} ID: ${nodeId} | [${role}] ${name}`);
        
        const maxDepth = targetNodeId ? depth + 1 : 1; // 仅多展示一层，由 AI 按需展开
        if (depth < maxDepth) {
          for (const childId of (node.childIds || [])) {
            printNode(childId, depth + 1);
          }
        }
    } else {
        // 递归挖掘通用容器
        for (const childId of (node.childIds || [])) {
          printNode(childId, depth);
        }
    }
  };

  printNode(targetNodeId || root.nodeId, 0);
  return output.join("\n");
}

// --- API Endpoints ---

// 1. Help Docs
app.get("/", (req, res) => {
  res.send(`
Browser Progressive MCP Proxy API
---------------------------------
GET  /                   - Show this help
GET  /tab                - List all tabs
POST /tab                - Open new tab. Body: { "url": "https://..." }
GET  /tab/:tabId         - List root elements of a tab (Progressive Disclosure)
GET  /tab/:tabId/:nodeId - List child elements of a specific node
GET  /screenshot/:tabId  - Capture screenshot as PNG
POST /tab/:tabId/:nodeId - Interact with a node. Body: { "action": "click"|"type", "value"?: "..." }
  `.trim());
});

// 2. List Tabs
app.get("/tab", async (req, res) => {
  try {
    const b = await getBrowser();
    const pages = await b.pages();
    const list = pages.map((p, i) => `[${i}] ${p.url()}`).join("\n");
    res.send(list || "No tabs open");
  } catch (e: any) { res.status(500).send(e.message); }
});

// 3. Add Tab
app.post("/tab", async (req, res) => {
  try {
    const { url } = req.body;
    const b = await getBrowser();
    const page = await b.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    res.send(`Opened ${url}`);
  } catch (e: any) { res.status(500).send(e.message); }
});

// 4. List Elements (Root)
app.get("/tab/:tabId", async (req, res) => {
  try {
    const { tabId } = req.params;
    const b = await getBrowser();
    const pages = await b.pages();
    const page = pages[parseInt(tabId)];
    if (!page) return res.status(404).send("Tab not found");

    const client = await page.target().createCDPSession();
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    res.send(formatAXTree(nodes)); // targetNodeId is undefined here
  } catch (e: any) { res.status(500).send(e.message); }
});

// 5. List Elements (Specific Node)
app.get("/tab/:tabId/:nodeId", async (req, res) => {
  try {
    const { tabId, nodeId } = req.params;
    const b = await getBrowser();
    const pages = await b.pages();
    const page = pages[parseInt(tabId)];
    if (!page) return res.status(404).send("Tab not found");

    const client = await page.target().createCDPSession();
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    res.send(formatAXTree(nodes, nodeId));
  } catch (e: any) { res.status(500).send(e.message); }
});

// 6. Screenshot
app.get("/screenshot/:tabId", async (req, res) => {
  try {
    const { tabId } = req.params;
    const b = await getBrowser();
    const pages = await b.pages();
    const page = pages[parseInt(tabId)];
    if (!page) return res.status(404).send("Tab not found");

    const buffer = await page.screenshot({ type: "png" });
    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch (e: any) { res.status(500).send(e.message); }
});

// 7. Interact
app.post("/tab/:tabId/:nodeId", async (req, res) => {
  try {
    const { tabId, nodeId } = req.params;
    const { action, value } = req.body;
    const b = await getBrowser();
    const pages = await b.pages();
    const page = pages[parseInt(tabId)];
    if (!page) return res.status(404).send("Tab not found");

    const client = await page.target().createCDPSession();
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    const node = nodes.find(n => n.nodeId === nodeId);
    if (!node || !node.backendDOMNodeId) return res.status(404).send("Node not found");

    if (action === "click") {
      const { model } = await client.send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
      const quad = model.content;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } else if (action === "type") {
      const { model } = await client.send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
      const quad = model.content;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      
      for (const char of (value || "")) {
        if (char === "\n") {
          await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, macCharCode: 13 });
          await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, macCharCode: 13 });
        } else {
          await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
          await client.send("Input.dispatchKeyEvent", { type: "keyUp" });
        }
      }
    }
    res.send(`Success: Physical ${action} on ${nodeId}`);
  } catch (e: any) { res.status(500).send(e.message); }
});

app.listen(3000, () => {
  console.log("Browser Progressive Backend running on http://localhost:3000");
});
