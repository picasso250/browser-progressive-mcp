# Browser Progressive Proxy

基于“渐进式披露”原则的浏览器自动化控制工具。

### 1. 启动环境
```bash
# 启动 Brave (或 Chrome)
& "brave.exe" --remote-debugging-port=9222 # 你需要先 curl :9222/json 来确认是否启动，如已经启动，则不用再次启动

# 启动后台服务
npx ts-node src/server.ts
```

### 2. API 概览 (Base: http://localhost:3000)

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| **GET** | `/` | 接口帮助文档 |
| **GET** | `/tab` | 列出所有标签页 |
| **POST** | `/tab` | 新建标签页 `url=https://...` |
| **GET** | `/tab/:id` | 列出根元素 (支持 URL 关键字匹配) |
| **GET** | `/tab/:id/node/:nodeId` | 展开指定节点 (支持 role/name 匹配) |
| **POST** | `/tab/:id/node/:nodeId` | 物理交互 `action=click` 或 `action=type`<br>`value=...` |
| **GET** | `/screenshot/:id` | 获取 PNG 截图 |

### 3. 使用示例
```bash
# 查看豆包的 main 区域
curl -s http://localhost:3000/tab/doubao/node/main # 因为id是容易变化的，所以你应该优先使用语义化的名称或者关键字

# 在输入框中输入
curl -X POST -H "Content-Type: text/plain" \
     --data-binary "action=type
value=hi" \
     http://localhost:3000/tab/doubao/node/5
```
