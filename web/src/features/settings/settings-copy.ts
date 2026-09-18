/**
 * 设置页与管理页的两段提示文案。
 *
 * ⚠️ **这两段是契约，不是文案建议**（SPEC §9.9、settings-ux.md §4）：不能删、不能弱化、
 *    不能改措辞。它们从规则原文逐字抄来，单独放在这个文件里是为了「改没改过」一眼可比——
 *    校验方式是把下面的字符串和 web/agents/rules/settings-ux.md §4 的两个代码块 diff。
 *
 * 「你的打标结果会进入公共库」一句尤其不能删——它是共享库代价在界面上的唯一体现。
 *
 * 渲染用 <pre>：文案的缩进和分行本身是结构（接口要求 / 警告 / 推荐 三段），
 * 拆成 <p> 重排会丢掉它，也会在下一次改动里悄悄走样。
 */

/** 用户设置页 · 视觉模型（settings-ux.md §4）。 */
export const VISION_NOTICE = `接口要求
  · 需兼容 OpenAI /v1/chat/completions
  · 必须支持图片输入（多模态）。纯文本模型会报 unsupported content type
  · 必须能稳定输出 JSON。优先选支持 response_format: {"type":"json_object"}
    或 tool calling 的模型
  · 不需要关心 GIF / WebP 支持 —— 系统会统一转成 PNG 再发送

⚠️ 你的打标结果会进入公共库，所有人都会搜到
  · 不填就用部署方的默认配置，那是经过验证的，多数情况下不需要改
  · 换成质量更差的模型，影响的是所有人的搜索结果

推荐
  · DeepSeek V4.1 Flash —— 中文语感好，单张约 $0.0007
  · 副通道建议配一个内容策略更宽松的供应商，用于主通道拒绝时降级`

/** 管理页 · Embedding（settings-ux.md §4）。 */
export const EMBED_NOTICE = `⚠️ 这是全站唯一一份 Embedding 配置，对所有用户生效

接口要求
  · 需兼容 OpenAI /v1/embeddings
  · 输出维度必须 ≥ 1024，系统会统一截断并重新归一化到 1024 维
  · 强烈建议选择支持 MRL（套娃表征）的模型，否则截断会明显降低检索质量
  · ⚠️ 更换模型会触发全站重新索引，期间搜索降级为 OCR + 标签

推荐
  · Qwen/Qwen3-Embedding-4B（硅基流动）—— 支持 MRL，中文强，延迟适中`
