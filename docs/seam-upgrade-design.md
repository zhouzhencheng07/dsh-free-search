# dsh-tavily-search 升级设计稿:接入 web seam + 多引擎故障转移

> 状态:**已实施(2026-08-16,项目更名为 dsh-free-search,见下方"实施记录")**。
> 设计稿正文保留原始调研结论;实施结果与设计差异见文末。

## 实施记录(2026-08-16)

- 项目更名为 **dsh-free-search**(package.json / 入口 `src/web-search.js` / cordis 行 id `free-search` / provider id `free-search`)。
- 独立工具 `tavily_search` **移除**(用户决策:去掉独立工具,内置 web_search 接管)。
- 实际引擎链:`github → arxiv → stackexchange → hn → tavily → sogou`;专用引擎按查询特征路由。
- 与设计稿差异:
  - **Baidu 未纳入**:新版 SERP 为 JS 渲染 SPA,静态 HTML 无结果,不可抓取。
  - **Sogou 替代 Baidu** 做中文兜底:跳转链接 `/link?url=` 通过 Referer + 解析
    `window.location.replace` 解出真实 URL(实测可行)。
  - **Firecrawl 未纳入**(设计稿曾列为兜底):其无 key 通道为未公开行为,暂不依赖;
    后续如需可在 `src/engines/` 新增并按 env 启用。
  - **github 引擎在本机受限**:hosts 文件(2026-08-14 修改)将 `api.github.com` 等指向
    127.0.0.1,Node fetch 被挡 → github 引擎在本机自动降级到 tavily(不影响链路)。
  - arxiv 引擎支持 ID 直达(`arxiv 1706.03762` → `id_list=` 查询)。
- 收尾(2026-08-16 完成):GitHub 仓库已改名 `dsh-free-search`(原 `dsh-tavily-search` 自动重定向),
  profile 依赖已从 `file:` 切回 `git+https://github.com/zhouzhencheng07/dsh-free-search.git` 并重装。
  剩余:重启 web 后验证 `web_search` 走免费引擎链。


## 1. 背景与问题

### 1.1 现状

- 插件注册独立工具 `tavily_search`,走 Tavily keyless(`X-Tavily-Access-Mode: keyless`),零配置零成本。
- 同时 harness(dsh 0.1.0-rc.6)自带 `web_search` 工具,base 层(`dsh-base/cordis.patch.yml`)把
  `web` 行的 `searchProvider` 固定为 `deepseek-official`。

### 1.2 实测发现的问题

1. **内置 `web_search` 当前是坏的**:`deepseek-official` provider 需要 `DEEPSEEK_API_KEY`,
   本机未配置 → 调用报 `WEB_PROVIDER_CREDENTIAL_MISSING`。模型侧出现两个搜索工具,但内置那个
   不可用,与我们的 `tavily_search` 功能重叠。
2. **单引擎无兜底**:Tavily keyless 若限流/故障,搜索直接失败。
3. **来源单一**:`liustack/modsearch` 有 5 个引擎(Tavily/Exa/Firecrawl/Antigravity/Grok)自动
   故障转移;我们只有 1 个。

### 1.3 免费引擎实测结论(当前网络)

| 引擎 | 免费额度 | 本网络可达 | 结论 |
|---|---|---|---|
| Tavily keyless | 免注册 | ✅ | 主引擎(现状) |
| Firecrawl `/v1/search` | key 1000 credits/月;实测**无 key 也可搜** | ✅ | 第二引擎;无 key 通道是未公开行为,需降级标注 |
| Bing Web Search API | Azure 免费档 ~1000 次/月 | ✅(需 key) | 可选 key 引擎 |
| SerpAPI | 100 次/月 | ✅ | 可选,仅作最后兜底 |
| Exa / Brave | 各 ~1000/月;Brave 免费档 2026-02 已取消 | ❌ api.exa.ai、api.search.brave.com 超时 | 排除 |
| Google CSE / Wikipedia API / DDG / SearXNG 公共实例 / Mojeek | - | ❌ 不通或反爬 | 排除 |
| 自建 SearXNG(Docker,上游 Bing) | 免费无限量 | Bing 可达 | 备选;Windows 需 Docker Desktop,运维重,不推荐首选 |

**结论**:免费可用的现实引擎链 = **Tavily keyless(主)→ Firecrawl(兜底)**;key 引擎
(Firecrawl/Bing/SerpAPI)按环境变量可选启用。

## 2. 目标

1. 修复内置 `web_search`:通过注册为 `ctx.web` 的 search provider,让内置工具走我们的引擎链,
   保留原生引用卡片 UI。
2. 多引擎自动故障转移:主引擎失败自动降级,不中断。
3. 保持插件定位:纯 ESM、零构建、零配置可用(无 key 也能跑);key 是可选增强。
4. 兼容:保留现有 `tavily_search` 独立工具(向后兼容),不破坏现有会话工作流。

## 3. 方案总览(学 modsearch)

- 新增一个 provider 文件,`apply(ctx)` 中调用 `ctx.web.registerSearchProvider(...)`。
- `cordis.patch.yml` 增加一行:把 `web` 行 config 的 `searchProvider` 改指向我们的 provider id
  (与 modsearch 的 patch 同模式)。
- 引擎链逻辑独立成模块,`tavily_search` 独立工具与 seam provider 共用同一引擎链。

### 3.1 seam 契约(已核对 dsh 0.1.0-rc.6 源码)

```ts
interface WebSearchProvider {
  id: string;                       // 稳定 id,注册表唯一键
  available(): boolean;             // 必须廉价、离线、无网络调用
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
// WebSearchRequest: { query: string; maxResults?: number }
// WebSearchResult:  { content?: string; sources: WebSearchSource[]; truncated: boolean }
// WebSearchSource:  { url: string; title?: string; snippet?: string; publishedAt?: string }
```

- 选择规则:配置的 `searchProvider` 优先(缺失/不可用会报错);未配置时仅一个可用 → 用它;
  多个可用 → `WEB_PROVIDER_AMBIGUOUS`。因此**必须**在 patch 里显式指定,不能只注册。
- seam 会在返回时按 `maxResults` 截断 `sources[]` 并置 `truncated`,provider 不必自己截。
- `available()` 恒真:Tavily keyless 无配置可用,引擎链始终可跑(诚实交给执行期判断)。

### 3.2 cordis.patch.yml 改动

```yaml
# 把 web 行的 searchProvider 指向我们的 provider(该行当前仅此一个 base key)
- id: web
  config:
    searchProvider: dsh-tavily-search

- insert:
    - id: tavily-search
      name: dsh-tavily-search
```

> 注意:modsearch 注释确认该行 config 只有 `searchProvider` 一个 base key,整体替换安全;
> 后续 profile 层 patch 可再改回。

## 4. 引擎链设计

### 4.1 引擎定义(内部)

```js
// 每引擎一个对象: 名称、是否可用、执行搜索 -> 规范化结果
{
  id: 'tavily' | 'firecrawl' | ...,
  available(env): boolean,          // 读 env,如 FIRECRAWL_API_KEY
  search(query, opts): Promise<EngineResult>,  // 失败 throw
}
```

引擎优先级(启动时按可用性过滤,运行时按序故障转移):

1. **tavily**(总是可用):
   - 有 `TAVILY_API_KEY` → 走 key 通道(`Authorization: Bearer`,可开 `include_answer`);
   - 无 key → keyless 通道(现状,`X-Tavily-Access-Mode: keyless`)。
2. **firecrawl**(有 `FIRECRAWL_API_KEY` 或允许无 key 兜底):
   - POST `https://api.firecrawl.dev/v1/search`,`{ query, limit }`;
   - 有 key 加 `Authorization: Bearer`;
   - 无 key 通道为实测行为(2026-08 可用),**结果标记降级**。
3. **bing**(可选,有 `BING_SEARCH_API_KEY` 时启用):Azure 免费档。
4. **serpapi**(可选,有 `SERPAPI_API_KEY` 时启用):额度小,仅最后兜底。

### 4.2 输出规范化

各引擎响应 → 统一 `EngineResult`:

```js
{ items: [{ url, title?, snippet?, publishedAt? }], summary?: string }
```

- Tavily:`results[]` → `{url, title: title, snippet: content}`;`answer` → summary。
- Firecrawl:`data[]` → `{url, title, snippet: description, publishedAt?}`。
- Bing/SerpAPI:按各自字段映射(url/title/snippet/date)。

### 4.3 故障转移规则

- 依次尝试:先按优先级用**健康且可用**的引擎;当前引擎失败(网络错误/HTTP 4xx/5xx/超时)
  立即切换下一个,把「本次实际由谁回答、为什么换」随结果带出(参考 modsearch 的 attempts 记录)。
- 全部失败 → throw 带尝试明细的错误。
- 超时:单引擎 15s,整体由调用方(seam 或工具 timeout)兜底;`signal` 透传给 fetch(AbortSignal
  合并:引擎超时 abort + 调用方 abort 任一触发)。

### 4.4 降级标注(可选增强)

- Firecrawl 无 key 通道成功 → 在 `content` 或错误信息里标注 "degraded: firecrawl keyless"。
- 具体呈现方式:seam 的 `WebSearchResult.content` 可带简短标注;或暂不做,保持简单。

## 5. 文件与代码结构(保持纯 ESM、零构建)

```
src/
  tavily-search.js        # 入口:apply(ctx) 注册 provider + 保留独立工具(见 §6)
  engine-chain.js         # 引擎列表、可用性、故障转移、规范化(独立模块,可单测)
  engines/tavily.js       # Tavily key/keyless 两通道
  engines/firecrawl.js    # Firecrawl 搜索
  engines/bing.js         # 可选
  engines/serpapi.js      # 可选
cordis.patch.yml          # 增加 web 行 searchProvider patch
README.md / README.en.md  # 说明:内置 web_search 也由本插件提供、key 环境变量表
```

- 不引入任何 npm 依赖;`@deepseek-ai/dsh-tools` 的 `defineTool` 继续用于独立工具。
- provider 注册不需要 import dsh-web(直接 `ctx.web.registerSearchProvider`,运行时判定
  `typeof ctx.web?.registerSearchProvider === 'function'`,缺失时降级为仅注册独立工具并
  console.error 说明——同 modsearch 做法)。

## 6. 独立工具 `tavily_search` 去留

- **建议保留**(v1):兼容现有会话/文档/工作流;与 seam provider 共用引擎链,行为一致。
- 后续若 seam 方案稳定、用户确认内置工具足够,可再移除独立工具,避免模型同时看到两个
  功能相同的工具(当前会话即如此)。
- 独立工具的 `execute` 改为调用 engine-chain,不再内联 Tavily 逻辑。

## 7. 测试与验证计划

1. **单元级**(可选,纯函数):engine-chain 的规范化/故障转移用 node 内置 test runner
   (`node --test`),无需依赖。
2. **集成验证**(本地 profile):
   - `dsh plugin add "file:..."` 或直接改 `profiles/web` 依赖后重启 `dsh web`;
   - 验证 `web_search` 可用且返回 `sources`(引用卡片出现);`tavily_search` 行为不变;
   - 故障注入:临时把 Tavily URL 指向不可达地址,验证自动切 Firecrawl 且结果带降级标注。
3. **回退**:改回 `searchProvider: deepseek-official` 或卸载插件即恢复原状(patch 只动 web 行)。

## 8. 风险与未决问题

| 风险 | 说明 | 对策 |
|---|---|---|
| Firecrawl 无 key 通道未公开,可能随时失效 | 实测可用但非契约 | 失效时自动只剩 Tavily;文档标注"实验性兜底" |
| Firecrawl 无 key 的配额/限流不明 | 可能被限 | 主引擎是 Tavily,Firecrawl 仅兜底 |
| 覆盖 `web` 行 config 影响其他部署 | base 层该行仅 `searchProvider` 一个 key | 与 modsearch 同模式,已确认安全 |
| key 引擎需要用户自行注册 | Bing 要 Azure 账号;SerpAPI 额度小 | 均为可选 env 启用,不阻塞默认体验 |
| 多个 provider 并存歧义 | 若其它插件也注册 provider 且未配置 | 本插件 patch 显式指定 id,不受影响 |

## 9. 实施步骤(下次执行)

1. 新建 `src/engine-chain.js` + `src/engines/*.js`,迁移现有 Tavily 逻辑,加 Firecrawl。
2. 改 `src/tavily-search.js`:注册 provider(seam 存在时)+ 独立工具共用链。
3. 改 `cordis.patch.yml`(§3.2)。
4. 更新 README(中/英):安装说明、key 环境变量表、降级行为。
5. 本地集成验证(§7),通过后 `feat:` 提交;push 前整理历史。
