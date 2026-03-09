---
name: browser
description: 让你可以操控浏览器
---

# Browser Progressive Proxy

基于“渐进式披露”原则的浏览器自动化控制工具。

### 1. 启动环境
```bash
# 启动 Brave (或 Chrome)
& "brave.exe" --remote-debugging-port=9222 # 你需要先 curl :9222/json 来确认是否启动，如已经启动，则不用再次启动

# 启动后台服务
npx ts-node src/server.ts # 同样的，你也需要先看一下这个后台服务是否已经启动
```

### 2. API 概览 (Base: http://localhost:3000)

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| **GET** | `/` | 接口帮助文档 |

### 3. 使用示例
```bash
# 查看豆包的 main 区域
curl -s http://localhost:3000/tab/doubao/node/main # 因为id是容易变化的，所以你应该优先使用语义化的名称或者关键字
```
