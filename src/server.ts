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

// 核心逻辑：渐进式披露 AXTree (采用“单子节点穿透”策略)
function formatAXTree(nodes: any[], targetNodeId?: string) {
  const nodeMap = new Map(nodes.map(n => [n.nodeId, n]));
  const root = nodes.find(n => n.role.value === "RootWebArea");
  if (!root) return "No RootWebArea found";

  const output: string[] = [];

  const printNode = (nodeId: string, depth: number) => {
    let node = nodeMap.get(nodeId);
    if (!node) return;

    // 1. 自动穿透逻辑：如果当前节点只有一个子节点，且不是用户指定的目标 ID，则继续向下挖掘
    while ((node.childIds || []).length === 1 && node.nodeId !== targetNodeId) {
      const nextNode = nodeMap.get(node.childIds![0]);
      if (!nextNode) break;
      node = nextNode;
    }

    const role = node.role?.value || "unknown";
    const name = node.name?.value || "";
    const childIds = node.childIds || [];

    // 2. 过滤掉极细微的文本行信息，保持树的骨干
    if (role === "InlineTextBox" || role === "LineBreak") return;

    const indent = "  ".repeat(depth);
    const hasChildren = childIds.length > 0;
    const childPrefix = hasChildren ? "[+]" : "   ";
    
    output.push(`${indent}${childPrefix} ID: ${node.nodeId} | [${role}] ${name}`);

    // 3. 展开逻辑：如果是初始视图 (depth 0) 或者是用户指定的展开目标
    if (depth === 0 || node.nodeId === targetNodeId) {
      for (const cid of childIds) {
        printNode(cid, depth + 1);
      }
    }
  };

  printNode(targetNodeId || root.nodeId, 0);
  return output.join("\n");
}

// 辅助函数：解析 tabId（支持索引和 URL 搜索）
function resolvePage(pages: any[], query: string) {
  if (/^\d+$/.test(query)) {
    const index = parseInt(query);
    return pages[index] || null;
  }
  
  const matches = pages
    .map((p, i) => ({ page: p, index: i }))
    .filter(m => m.page.url().toLowerCase().includes(query.toLowerCase()));

  if (matches.length === 0) {
    throw new Error(`Tab not found for query: ${query}`);
  }
  if (matches.length > 1) {
    const list = matches.map(m => `[${m.index}] ${m.page.url()}`).join("\n");
    throw new Error(`Ambiguous query: '${query}' matches multiple tabs:\n${list}\nPlease specify a precise numeric ID.`);
  }
  return matches[0].page;
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
GET  /tab/:tabId         - List root elements. tabId can be index (0) or URL search (doubao)
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
    let page;
    try { page = resolvePage(pages, tabId); } catch(err:any) { return res.status(400).send(err.message); }
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
    let page;
    try { page = resolvePage(pages, tabId); } catch(err:any) { return res.status(400).send(err.message); }
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
    let page;
    try { page = resolvePage(pages, tabId); } catch(err:any) { return res.status(400).send(err.message); }
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
    let page;
    try { page = resolvePage(pages, tabId); } catch(err:any) { return res.status(400).send(err.message); }
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
