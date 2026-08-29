// dsh-kit 网页搜索能力（自 dsh-free-search v0.2.0 并入，2026-08-24）
//
// 向 web seam 注册 id 为 'free-search' 的搜索 provider，替换 base 层钉死的
// `searchProvider: deepseek-official`（付费 DeepSeek 模型调用）——引擎链见
// ./engine-chain.js（Tavily 免 key 优先，Bing RSS/Sogou/GitHub/arXiv/
// StackExchange/HN 回退），原生引用卡片照常渲染（seam 直接消费 sources[]）。
// cordis.patch.yml 负责 patch web 行的 searchProvider 配置，本文件只负责注册。
//
// 设置卡 searchEnabled 开关（默认开）在【启动期】一次定夺该 id 背后挂哪种实现：
//   开 = 免费引擎链；
//   关 = 同 id 转发官方渠道（deepseek-official，搜索时现查注册表）。
// searchMaxResults（1-8，默认 5）管单次搜索的来源条数上限：取 seam 请求量与
// 设置上限的较小值，provider 每次现读、改完即生效（条数越多上下文消耗越大）。
// 切换不做热生效——改开关重启后生效。为什么"关"也要注册：patch 静态把
// searchProvider 钉在 free-search，若此时不注册，seam 只会抛
// WEB_PROVIDER_CONFIGURED_MISSING 而不会回落默认；同 id 转发让"关=官方默认"
// 成立。registerSearchProvider 对重复 id 抛 WEB_DUPLICATE_PROVIDER，故注册前
// 查重入、失败降级为告警不炸插件。

import { searchChain } from './engine-chain.js'

export const SEARCH_PROVIDER_ID = 'free-search'

// 关闭开关时的转发目标（dsh base 自带 dsh-web-search-deepseek 的注册 id）
const OFFICIAL_PROVIDER_ID = 'deepseek-official'

export function applyWebSearch(ctx, { getEnabled = () => true, getMaxResults = () => 5 } = {}) {
  ctx.inject(['web'], (webCtx) => {
    if (typeof webCtx.web?.registerSearchProvider !== 'function') {
      // developer-preview 面挪走了：降级为日志，不让整个插件消失
      console.error('[dsh-kit] web seam 没有 registerSearchProvider，搜索能力跳过')
      return
    }
    if (webCtx.web.searchProviders?.has(SEARCH_PROVIDER_ID)) {
      console.error(`[dsh-kit] "${SEARCH_PROVIDER_ID}" 已被注册（旧版独立插件未卸载？），搜索能力跳过`)
      return
    }

    /** 找转发目标：优先官方源，退而求其次任一其它可用源；没有回 null */
    const findFallback = () => {
      const registry = webCtx.web.searchProviders
      if (!registry || typeof registry.values !== 'function') return null
      const preferred = registry.get(OFFICIAL_PROVIDER_ID)
      if (preferred && preferred.available?.() !== false) return preferred
      for (const provider of registry.values()) {
        if (provider.id === SEARCH_PROVIDER_ID || provider.id === OFFICIAL_PROVIDER_ID) continue
        if (provider.available?.() !== false) return provider
      }
      return null
    }

    /** 本次搜索的条数上限：设置项 searchMaxResults（1-8，默认 5），每次现读 */
    const resultCap = () => {
      const n = getMaxResults()
      return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 5
    }

    const enabled = getEnabled()
    try {
      webCtx.web.registerSearchProvider({
        id: SEARCH_PROVIDER_ID,
        available: () => true,
        async search(request, signal) {
          if (!enabled) {
            // 关：让位官方/替代源（每次调用现查，规避启动期注册顺序问题）
            const fallback = findFallback()
            if (!fallback) {
              throw new Error('网页搜索已停用：没有可用的官方/替代搜索源（检查 deepseek-official 是否注册且凭据可用）')
            }
            return fallback.search(request, signal)
          }
          // 条数取"seam 请求量与设置上限的较小值"：seam 要得少就少给（省上下文），
          // 要得多也不超过设置上限（搜索条数多=无谓的 token 消耗）
          const maxResults = Math.min(request.maxResults ?? resultCap(), resultCap())
          const { items, summary } = await searchChain(request.query, {
            maxResults,
            signal,
          })
          return {
            ...(summary ? { content: summary } : {}),
            sources: items.map((item) => ({
              url: item.url,
              ...(item.title ? { title: item.title } : {}),
              ...(item.snippet ? { snippet: item.snippet } : {}),
              ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
            })),
            // seam 自己按 request.maxResults 截断 sources[]
            truncated: false,
          }
        },
      })
    } catch (error) {
      console.error(`[dsh-kit] free-search provider 注册失败：${error?.message ?? error}`)
    }
  })
}
