import express from "express";
import puppeteer, { Browser } from "puppeteer-core";

const app = express();
// 仅使用 text middleware 接收所有原始文本
app.use(express.text({ type: '*/*', limit: '1mb' }));

const BROWSER_ENDPOINT = "http://localhost:9222";
let browser: Browser | null = null;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

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
    const childIds = node.childIds || [];

    if (role === "InlineTextBox" || role === "LineBreak") return;

    const isGeneric = role === "generic" || role === "none";
    const isRoot = role === "RootWebArea";
    const isTarget = node.nodeId === targetNodeId;

    if (!isRoot && !isTarget && isGeneric && !name) {
      for (const cid of childIds) {
        printNode(cid, depth);
      }
      return;
    }

    const indent = "  ".repeat(depth);
    const hasChildren = childIds.length > 0;
    const childPrefix = hasChildren ? "[+]" : "   ";
    output.push(`${indent}${childPrefix} ID: ${node.nodeId} | [${role}] ${name}`);

    if (depth === 0 || isTarget) {
      for (const cid of childIds) {
        printNode(cid, depth + 1);
      }
    }
  };

  printNode(targetNodeId || root.nodeId, 0);
  return output.join("\n");
}

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

function resolveNodeId(nodes: any[], query: string) {
  if (/^-?\d+$/.test(query)) return query;
  const matches = nodes.filter(n => (n.role?.value === query) || (n.name?.value === query));
  if (matches.length === 0) throw new Error(`Node not found for semantic query: '${query}'`);
  if (matches.length > 1) {
    const list = matches.map(n => `ID: ${n.nodeId} | [${n.role?.value}] ${n.name?.value || ""}`).join("\n");
    throw new Error(`Ambiguous node query: '${query}' matches multiple elements:\n${list}`);
  }
  return matches[0].nodeId;
}

async function resolveTargetNodeCenter(tabId: string, nodeId: string) {
  const b = await getBrowser();
  const pages = await b.pages();
  const page = resolvePage(pages, tabId);
  if (!page) throw new Error("Tab not found");
  const client = await page.target().createCDPSession();
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  const targetId = resolveNodeId(nodes, nodeId);
  const node = nodes.find(n => n.nodeId === targetId);
  if (!node || !node.backendDOMNodeId) throw new Error("Node not found");

  const { model } = await client.send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
  const quad = model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  return { x, y, client };
}

// API Endpoints
app.get("/", (req, res) => {
  const help = `
Browser Progressive API (Raw Text Mode)
--------------------------------------
GET  /tab                            - List all open tabs
POST /tab                            - Open a new tab (body: url)
GET  /tab/:tabId                     - Get AXTree for a tab
GET  /tab/:tabId/node/:nodeId        - Get AXTree subtree for a node
GET  /screenshot/:tabId              - Get screenshot (PNG)
POST /tab/:tabId/node/:nodeId/click  - Physical click on node
POST /tab/:tabId/node/:nodeId/scroll - Physical scroll on node (body: deltaY)
POST /tab/:tabId/node/:nodeId/type   - Physical type on node (body: text)
POST /eval/:tabId                   - Evaluate JS in tab (body: script)
`.trim();
  res.send(help);
});

app.get("/tab", async (req, res) => {
  try {
    const b = await getBrowser();
    const pages = await b.pages();
    res.send(pages.map((p, i) => `[${i}] ${p.url()}`).join("\n") || "No tabs open");
  } catch (e: any) { res.status(500).send(e.message); }
});

app.post("/tab", async (req, res) => {
  try {
    const url = req.body.trim();
    const b = await getBrowser();
    const page = await b.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(1000);
    res.send(`Opened ${url}`);
  } catch (e: any) { res.status(500).send(e.message); }
});

app.get("/tab/:tabId", async (req, res) => {
  try {
    const { tabId } = req.params;
    const b = await getBrowser();
    const pages = await b.pages();
    const page = resolvePage(pages, tabId);
    if (!page) return res.status(404).send("Tab not found");
    const client = await page.target().createCDPSession();
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    res.send(formatAXTree(nodes));
  } catch (e: any) { res.status(500).send(e.message); }
});

app.get("/tab/:tabId/node/:nodeId", async (req, res) => {
  try {
    const { tabId, nodeId } = req.params;
    const b = await getBrowser();
    const pages = await b.pages();
    const page = resolvePage(pages, tabId);
    if (!page) return res.status(404).send("Tab not found");
    const client = await page.target().createCDPSession();
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    const targetId = resolveNodeId(nodes, nodeId);
    res.send(formatAXTree(nodes, targetId));
  } catch (e: any) { res.status(500).send(e.message); }
});

app.get("/screenshot/:tabId", async (req, res) => {
  try {
    const { tabId } = req.params;
    const b = await getBrowser();
    const pages = await b.pages();
    const page = resolvePage(pages, tabId);
    if (!page) return res.status(404).send("Tab not found");
    res.setHeader("Content-Type", "image/png");
    res.send(await page.screenshot({ type: "png" }));
  } catch (e: any) { res.status(500).send(e.message); }
});

app.post("/tab/:tabId/node/:nodeId/click", async (req, res) => {
  try {
    const { tabId, nodeId } = req.params;
    const { x, y, client } = await resolveTargetNodeCenter(tabId, nodeId);
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(1000);
    res.send(`Success: Physical click on ${nodeId}`);
  } catch (e: any) { res.status(500).send(e.message); }
});

app.post("/tab/:tabId/node/:nodeId/scroll", async (req, res) => {
  try {
    const { tabId, nodeId } = req.params;
    const value = req.body.trim();
    const { x, y, client } = await resolveTargetNodeCenter(tabId, nodeId);
    await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: parseInt(value || "100") });
    await sleep(1000);
    res.send(`Success: Physical scroll on ${nodeId}`);
  } catch (e: any) { res.status(500).send(e.message); }
});

app.post("/tab/:tabId/node/:nodeId/type", async (req, res) => {
  try {
    const { tabId, nodeId } = req.params;
    const text = req.body.trim();
    const { x, y, client } = await resolveTargetNodeCenter(tabId, nodeId);

    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    if (text === "{Control+A}{Backspace}") {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, key: "a", code: "KeyA" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, key: "a", code: "KeyA" });
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
    } else if (text === "{Backspace}") {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
    } else if (text === "{Enter}") {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    } else if (text === "{ArrowDown}") {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, key: "ArrowDown", code: "ArrowDown" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, key: "ArrowDown", code: "ArrowDown" });
    } else if (text === "{ArrowUp}") {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38, key: "ArrowUp", code: "ArrowUp" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38, key: "ArrowUp", code: "ArrowUp" });
    } else if (text === "{Tab}") {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: "Tab", code: "Tab" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: "Tab", code: "Tab" });
    } else {
      for (const char of text) {
        if (char === "\b") {
          await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
          await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
        } else {
          await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
          await client.send("Input.dispatchKeyEvent", { type: "keyUp" });
        }
      }
    }
    await sleep(1000);
    res.send(`Success: Physical type on ${nodeId}`);
  } catch (e: any) { res.status(500).send(e.message); }
});

app.post("/eval/:tabId", async (req, res) => {
  try {
    const { tabId } = req.params;
    const script = req.body;
    if (!script) return res.status(400).send("No script provided");
    const b = await getBrowser();
    const pages = await b.pages();
    const page = resolvePage(pages, tabId);
    if (!page) return res.status(404).send("Tab not found");
    const result = await page.evaluate(script);
    await sleep(1000);
    res.send(typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result));
  } catch (e: any) { res.status(500).send(e.message); }
});

app.listen(3000, () => {
  console.log("Browser Progressive Backend (Raw Mode) running on http://localhost:3000");
});
