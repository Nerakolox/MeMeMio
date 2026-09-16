/**
 * 图像管线的调优参数。**是常量，不是环境变量** —— 部署方没有理由调它们，
 * 放进 env 只会让「多图上限到底是几」变成每个部署都不同的谜。见 agents/rules/image-pipeline.md §3。
 */

/**
 * 单次请求最多送 AI 的帧数。
 *
 * 上限只为给成本和请求大小封顶，不是「一般都发全帧」。实测 989 张真实库里
 * 去重后状态数中位数 9、均值 15.3、最大 81，**只有 55% 的动图 ≤10 帧**，
 * 所以采样是常态。取 4 会有 72% 的动图被裁。见 agents/rules/image-pipeline.md §3。
 */
export const MAX_FRAMES = 10

/**
 * 拼图兜底路径固定用 4 帧（且是 2×2）。
 *
 * **和 MAX_FRAMES 不同是有意的**：拼图受限于分辨率而不是数量，3×3 只会让小字更糊。
 * 不要「顺手统一」。见 agents/rules/image-pipeline.md §3。
 */
export const COLLAGE_FRAMES = 4

/** 送 AI 的静图长边。只缩不放——放大不会凭空生出信息，只会让模型把插值糊出来的笔画猜成文字。 */
export const AI_LONG_EDGE = 512

/** 缩略图长边。列表页一屏几十张，直接加载原图会把流量打爆。 */
export const THUMB_LONG_EDGE = 400

/**
 * ffmpeg 子进程超时。**必须有**：一个损坏的文件能让 ffmpeg 挂住不退出，
 * 几个这样的就能把机器打满，而表现只是「导入进度条不动」。见 image-pipeline.md §8。
 */
export const FFMPEG_TIMEOUT_MS = 20_000

/**
 * ffmpeg 并发上限。超时解决单个卡死，并发上限解决它们一起卡死。
 *
 * 每个 ffmpeg 进程都可能吃掉几百 MB 内存，不设上限的话一批损坏文件能把机器打满。
 */
export const FFMPEG_CONCURRENCY = 2

/** ffprobe 只是读容器头，比抽帧轻得多，超时可以更短。 */
export const FFPROBE_TIMEOUT_MS = 8_000

/**
 * 帧间去重的 Hamming 阈值（**不是**入库去重那个阈值）。
 *
 * 作用对象不同：这里比的是同一个文件的相邻帧（长静止段），入库去重比的是跨文件的整图。
 * 两者**不要复用同一个阈值，也不要共用同一个函数名**。见 image-pipeline.md §3 的警告框。
 */
export const FRAME_DEDUP_DISTANCE = 4

/** 单个文件大小上限。超出报 FILE_TOO_LARGE（SPEC §2.3）。 */
export const MAX_FILE_BYTES = 20n * 1024n * 1024n

/**
 * 入库近似重复的 Hamming 阈值（**不是**帧间去重那个，见 FRAME_DEDUP_DISTANCE）。
 *
 * 64 位哈希取 8 相当于 ~12.5% 的位差异。**这是保守值，理由是不对称的**：
 * 判成近似重复只是让用户多看一眼（一次点击），漏判会让库里多一份重复——
 * 前者是麻烦，后者是库质量下降且很难事后清理。所以宁可多报。
 *
 * ⚠️ **但这个阈值不是纯调优参数，它决定了用户在待确认队列里要处理多少条。**
 * 调高会明显增加用户的操作量，调低会让重复漏进来。正式取值要靠评测集实测
 * （SPEC §9.16 待验证项），现在这个数字只是有依据的起点，不要当作已校准。
 *
 * 判断权始终在**人**：pHash 会误判——同一模板换了字的两张图距离可能很近，
 * 但它们是两张不同的图。所以这里只攒队列，不做任何自动处理。
 */
export const NEAR_DUP_DISTANCE = 8
