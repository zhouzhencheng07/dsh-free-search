// @deepseek-ai/dsh-tools 不进包依赖（宿主侧运行时经两锚点动态解析，见 browser-tools.ts），
// 类型面按 any 兜底——真正的形状校验在 dsh-tools 的 schema 编译器里做。
declare module '@deepseek-ai/dsh-tools'
