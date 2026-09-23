/**
 * 全站提示（toast）的**唯一落点**。
 *
 * 业务组件不直接 `import { toast } from 'sonner'`——文案、时长、「谁该弹谁不该弹」
 * 的判据都收在这里，理由与 `lib/clipboard.ts` 把发送文案集中起来是同一条：
 * 同一个动作在首页和浏览页必须说同一句话。判据全文见 `web/agents/rules/feedback.md`。
 *
 * 四条判据（新加一个动作按钮时按它办）：
 *
 * 1. **成功态已经看得见的，不弹成功提示**——收藏的心形、导入的整页切换、
 *    筛选后的重取、重试出现的骨架屏。给这些补一句「操作成功」只是噪音。
 * 2. **失败一律弹，且不自动消失**（`notifyFailure`）——除设置页的保存，见下。
 * 3. **成功态看不见的，弹**——剪贴板（写入不可见）、删除、生成邀请码、
 *    「放弃修改」（扔掉的是用户刚打进去的字）。
 * 4. **导航类不弹**——换页本身就是反馈。
 *
 * 「保存」是容易判错的一档，规则 1/2 对它都**要让半步**：它属于**表单**，
 * 确认就近留在那张表单里（行内），不进这里——`UsersSettings` / `MemeEditPanel`
 * 两处都是这个道理，设置页另外四张卡也一样（`http.md §5`：设置页不弹 toast）。
 * 与之配套地，设置页的**失败**也留在行内（那边本来就是带 requestId 的 `role="alert"`），
 * 成功改成 toast 只会让同一行有两个渠道。
 */

import { toast } from 'sonner'
import type { SendNote } from './clipboard'

/**
 * 成功类自动消失的时间（sonner 的默认值也是 4000，显式写出来是为了让
 * 「成功会自己收掉、失败不会」这条对照在代码里看得见）。
 */
export const SUCCESS_MS = 4000

/**
 * 成功提示。**只在「成功这件事本身看不见」时用**（判据 3）。
 *
 * 用中性样式而不是 `toast.success`：那会走 sonner 自己的 `--success-*` 绿色，
 * 而本项目的成功态没有绿色这一档（`styling.md` 的「状态的视觉表达」里，
 * 成功是「角标 / 文案」，不是颜色）。要走颜色就得再映射一组 token，不值得。
 */
export function notifySuccess(text: string): void {
  toast(text, { duration: SUCCESS_MS })
}

/**
 * 失败提示。**不自动消失**（判据 2）。
 *
 * `requestId` 必须展示（`http.md §3`）：它是用户报问题时唯一能对上服务端日志的东西，
 * 而一个 4 秒就收掉的提示会在他抄下来之前消失。常驻的提示都带关闭按钮
 * （`components/ui/sonner.tsx` 的 `closeButton`），所以关得掉。
 *
 * `requestId` 用 `!` 覆盖字号与颜色：sonner 给说明行写死了两组灰色，且是无层 CSS
 * （`[data-description]{color:#3f3f3f}` / `#e8e8e8`），普通工具类压不过——
 * 同 `components/ui/sonner.tsx` 头部那条。字号本来不冲突（它是写在自己的元素上），
 * 但仍然要 `!` 才能盖过无层表里的 `color`。
 */
export function notifyFailure(text: string, requestId?: string): void {
  toast.error(text, {
    duration: Infinity,
    description:
      requestId === undefined ? undefined : (
        <span className="font-mono text-xs! text-muted-foreground!">requestId：{requestId}</span>
      ),
  })
}

/**
 * 一次「发送」的结果。文案仍由 `lib/clipboard.ts` 的 `sendNote` 定，这里只负责**呈现**。
 *
 * 两条分支是两种形态，不是两种颜色：
 *
 * - 普通结果 4 秒收掉；
 * - **取不到原图那条常驻，并且给一个能点的链接**。它不是「失败」而是降级
 *   ——`http.md §5` 明写「降级不是错误」，所以这里用中性样式，**不是** `toast.error`。
 *   但它需要用户自己动一下手（点链接打开原图再存），所以不能 4 秒就收掉。
 *
 * 链接是**真的 `<a target="_blank">`**，不是 `window.open`：走到这一步时已经取过一次图，
 * 用户手势早没了，`window.open` 会被拦掉而文案还写着「已打开」——
 * 完整推导在 `lib/clipboard.ts` 的 `saveFile`。
 */
export function notifySend(note: SendNote): void {
  if (note.fallbackUrl === undefined) {
    notifySuccess(note.text)
    return
  }

  toast(note.text, {
    duration: Infinity,
    description: (
      <a
        className="underline underline-offset-2"
        href={note.fallbackUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        在新标签页打开原图
      </a>
    ),
  })
}
