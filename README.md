[English](README.en.md) | 中文

# dsh-tavily-search

面向 DeepSeek Harness (dsh) 的免费 Tavily 网页搜索工具（keyless 模式）。

注册一个工具：`tavily_search` —— 实时网页搜索，返回标题、URL 和内容摘要。
使用 Tavily 的 keyless 访问模式（`X-Tavily-Access-Mode: keyless`），**无需 API Key、零额外成本**。

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-tavily-search"
```

本包声明了 `dsh.bundle.patch`，因此会被激活为 profile 的 bundle 层（而不是仅仅装成
一个不生效的普通依赖）。安装后重启 `dsh web`，模型即获得 `tavily_search` 工具。

### 本地开发安装

```bash
# 本地开发安装：把路径换成你自己的本地检出目录
dsh plugin --profile web add "file:/path/to/dsh-tavily-search"
```

> 如果你之前是用 `--patch ./scratch-plugin/...` 参数加载本插件的，请从启动命令中
> 去掉该参数——现在由 bundle 持有 `tavily-search` 行，重复 insert 会导致启动失败。

## 环境要求

- Node.js ≥ 22（dsh 自身要求）
- profile 能解析到 `@deepseek-ai/dsh-tools`（dsh 自带安装；无需显式声明依赖，
  通过 Node 逐级向上查找解析）

## 开发说明

- 源码：`src/tavily-search.js`（刻意使用纯 ESM JavaScript——无需构建步骤，
  任何 dsh 构建都能直接加载）。
- 本包是 dsh **bundle**：`package.json` 中声明了
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，这正是 `dsh plugin add`
  安装后能成为活跃 profile 层的关键。

## 许可证

MIT
