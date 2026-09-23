import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * 全站提示（toast）。**只有这一份**，挂在 `App.tsx` 的 `Routes` **之外**：
 * 登录 / 注册页不带外壳，挂进 `AppLayout` 那两页就用不上了。
 *
 * 调用一律走 `@/lib/toast`（`notifySuccess` / `notifyFailure` / `notifySend`），
 * 不在业务组件里直接 `import { toast } from 'sonner'`——文案与「谁该弹、谁不该弹」
 * 的判据集中在那里。见 `web/agents/rules/feedback.md`。
 *
 * ## 为什么覆写的是 sonner 自己的 CSS 变量，而不是给它加 Tailwind 类
 *
 * sonner 把样式**在运行时注入 head，而且是无层的**（没有 `@layer`）。无层声明压过
 * Tailwind 的 `@layer utilities`，所以在 `[data-sonner-toast]` 上写工具类是**静默失效**——
 * 与 `LightboxViewer` 那条一模一样（`styling.md`）。颜色与圆角一律走它的
 * `--normal-*` / `--error-*` / `--border-radius`，且**内联在元素上**：内联样式
 * 无条件赢过无层表，`class` 写法则要看注入顺序，不确定。
 *
 * 值的来源是本项目的语义 token，**不写 HEX**（`styling.md`）。`--popover` 与 `--card`
 * 在浅色 / 深色下都是同一个值（`oklch(1 0 0)` / `oklch(0.205 0 0)`），所以
 * 「说明文字落在卡片底色上对比度 4.7 / 6.9」那条推导在这里照样成立。
 *
 * 错误态用 `bg-popover + text-destructive`，与 `ui/alert.tsx` 的 destructive 变体同配方
 * （`bg-card text-destructive`），不自己另调一套红。
 *
 * ## z-index 60：高于 Radix 那层（50），低于全屏阅览（9999）
 *
 * sonner 自带 `z-index: 999999999`，且**写在元素自身的无层规则里**，普通 class 压不住，
 * 所以这里用内联 `style` 强制收下来。不收的话，编辑侧边栏 / 抽屉开着时
 * toast 到底在不在抽屉上面没人说得清，也违反 `styling.md` 那条
 * 「层级只和几个邻居有关，不是越大越保险」的口径。
 *
 * ## 避开顶栏
 *
 * 顶栏是吸顶的 `--app-header-h`（56px），而右上角**正好是「导入 N/M」进度入口**
 * （`App.tsx` 的 `ImportProgressLink`）。offset 减掉它，否则导入跑着的时候
 * toast 正好盖住那个入口。手机那一档走 `mobileOffset`，是 sonner 分开两套变量。
 *
 * ## `pointer-events: auto` 不是多余的
 *
 * Radix 的模态会给 `body` 挂 `pointer-events: none`，而 toast 是 `body` 的后代——
 * 不显式写回 `auto`，**模态开着时弹的 toast 就点不动**：关闭按钮和「打开原图」
 * 链接都是死的，而它在屏幕上看着完全正常。这条不报错。
 *
 * ## 已知缺口（不是遗漏，是取舍）
 *
 * Radix 模态还会给 `#root` 等 body 子节点挂 `aria-hidden`，所以**对话框开着时弹的
 * toast 读屏听不见**。正因如此，表单 / 模态内的保存确认走行内（`UsersSettings`、
 * `MemeEditPanel`），不走这里——那两处要修的本来就是「反馈看不见」。
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      /*
        `system` 而不是 `light`：本项目的深色是 `prefers-color-scheme`，
        没有 `.dark` class，也没有手动开关（`styling.md`「深色模式」）。
        `system` 正是读这个媒体查询，与 `index.css` 那份深色 token 同一套判据。
      */
      theme="system"
      position="top-right"
      /*
        常驻的失败提示（`duration: Infinity`）**必须有关闭按钮**，否则关不掉。
        ⚠️ 标签要显式换掉，而且它在 `toastOptions` 里**不在 ToasterProps 上**
        （`closeButton` 在 ToasterProps，`closeButtonAriaLabel` 在 ToastOptions——
        放错地方 tsc 会报，不会静默）。库默认是英文的 `Close toast`，
        同 `LightboxViewer` 里「插件的文案是插件自己那份」那条（`styling.md`）。
      */
      closeButton
      /*
        承载 toast 的那个 `<section>` 是一块 `aria-live="polite"` 的**播报区**，库给它写的
        `aria-label` 默认是英文的 `Notifications alt+T`。这里只换前半句、
        用 `containerAriaLabel` 而不是 `customAriaLabel`：后者会把整条标签替掉，
        连 `alt+T` 那个快捷键提示一起丢掉——库给这块区域配了热键（`hotkey` 默认
        `['altKey','KeyT']`），键盘用户靠它把焦点送进来，提示没了就没人知道有这条路。
        与 `关闭提示` 是同一条：库的文案是库自己那份，能改的都要改成中文。
      */
      containerAriaLabel="通知"
      /*
        ⚠️ **`richColors` 不能省，它是下面那三个 `--error-*` 变量生效的开关。**

        给 `--error-bg` / `--error-border` / `--error-text` 赋了值，但 sonner 只在
        `[data-rich-colors='true'][data-sonner-toast][data-type='error']` 那条规则里读它们
        （`styles.css`），而那个属性由 `richColors` 决定。不开的话三个变量**一个都不起作用**
        ——`toast.error()` 出来的东西与普通提示长得一模一样，只是不自动消失。
        这条不报错：是验收里「删除失败那条是错误色」那条断言一开始就是红的才发现的，
        记在这里免得下一个人以为「变量赋了就是配好了」。

        `richColors` 只影响**有 `data-type` 的** toast。`success` / `info` / `warning`
        三档在 `lib/toast.tsx` 里一个都没用（成功走的是中性的 `toast()`，见那里的注释），
        所以开它实际只改了错误这一档，不会把这个项目里不存在的绿 / 黄带进来。
      */
      richColors
      style={
        {
          zIndex: 60,
          pointerEvents: "auto",
          "--border-radius": "var(--radius-2xl)",
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--error-bg": "var(--popover)",
          "--error-text": "var(--destructive)",
          "--error-border": "var(--destructive)",
        } as React.CSSProperties
      }
      offset={{ top: "calc(var(--app-header-h) + 0.75rem)", right: "1rem" }}
      mobileOffset={{ top: "calc(var(--app-header-h) + 0.75rem)", right: "1rem", left: "1rem" }}
      toastOptions={{
        closeButtonAriaLabel: "关闭提示",
        /*
          sonner 自己给 toast 写死 `font-size: 13px`（在那条无层规则里，比继承更硬），
          而这条提示替代的是页面里原本 `text-sm` 的行内文字。`!` 是这条无层规则唯一
          压得过的写法。
        */
        classNames: { toast: "text-sm!" },
      }}
      {...props}
    />
  )
}
