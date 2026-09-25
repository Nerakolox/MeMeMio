import { lazy, Suspense } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/auth'
import { ImportProvider, useImport } from './contexts/import'
import { AppSidebar } from './components/AppSidebar'
import { ImageViewerProvider } from './components/ImageViewer'
import { Button } from './components/ui/button'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { loginPath } from './lib/api'
import { HomePage } from './routes/home'
import { BrowsePage } from './routes/browse'
import { LoginPage } from './routes/login'
import { RegisterPage } from './routes/register'
import { NotFoundPage } from './routes/not-found'
import { isSettled } from './features/import/use-import-queue'

/*
  导入页与设置页**切出去按需加载**。

  它们不是首屏路径：`/` 与 `/browse` 是打开应用就会走的两条，用户点进设置或导入之前，
  这两页的代码只是白下载。导入页带着待确认队列与上传那套、设置页带着全部管理面板
  （用户、邀请码、打标、重建索引），是首屏包里最重的两块之一。

  用 `import()` 时**不从模块顶层 import 页面**，否则打包器按静态依赖留在首屏包里，
  `lazy` 就只剩一个空壳。`Suspense` 边界在下面 `AppLayout` 的 `<Outlet>` 上，见那里的注释。
*/
const ImportPage = lazy(() => import('./routes/import').then((m) => ({ default: m.ImportPage })))
const SettingsPage = lazy(() =>
  import('./routes/settings').then((m) => ({ default: m.SettingsPage })),
)

/**
 * 组件参照页（`/ui`）**不进生产包**。
 *
 * 它是给开发看「主题下 shadcn 组件长什么样」的，用户点不到也不需要，但它 import 了
 * **全部** `components/ui/*`——留在包里等于让每个用户多下一份谁都用不上的代码。
 *
 * 三道一起才成立：`import.meta.env.DEV` 为假时这个三元表达式常量折叠成 `null`，
 * 那条 `import()` 随之成为死代码（`vite build` 不再产出这个 chunk）；`lazy` 让开发
 * 时它也只在真的访问 `/ui` 时才加载；`Suspense` 是 `lazy` 的必需搭配，没有它整页报错。
 * 单独只用 `lazy` 是不够的——那会把参照页切成一个**仍然会发布**的 chunk。
 */
const UiPage = import.meta.env.DEV
  ? lazy(() => import('./routes/ui').then((m) => ({ default: m.UiPage })))
  : null

/** 未登录就跳登录页，并把当前地址原样带过去（state-navigation.md §5）。 */
function RequireAuth() {
  const { user } = useAuth()
  const location = useLocation()
  if (!user) {
    return <Navigate to={loginPath(location.pathname + location.search)} replace />
  }
  return <Outlet />
}

/**
 * 首页那条路由：**带 `?q=` 进来的一律交棒给 `/browse`**（2026-09-26 首页改版）。
 *
 * 首页此前自己也搜——`/?q=…` 走冻结的 `GET /search`，结果渲染在同一个页面上。
 * 现在首页是入口页、不渲染结果（SPEC §9.30），带查询词进来的人想要的显然还是「搜」，
 * 所以把他送到那条真的能筛、能翻的列表上，而不是给他一张空首页。
 *
 * 谁还会带 `?q=` 进 `/`：**别人分享的老链接、书签、以及改版前的浏览器历史**。
 * 这也正是 `state-navigation.md §1` 那条（「一次搜索是可分享的状态」）的现实含义——
 * 那些链接已经散在外面了，删掉这条路等于把它们变成 404。
 *
 * 写法沿用 `/admin/*` 那三条：**`<Navigate replace />`，而且必须挂在布局路由里面**
 * （挂外面会先卸掉整条外壳再挂回来，闪一下）。
 *
 * 空词（`/?q=` 或 `/`）**不重定向**：把人送到一个空搜索的 `/browse` 上，
 * 他看到的是「没有符合条件的图片」，而明明什么都没输入。渲染首页，那个空参数就留着不发。
 */
function HomeRoute() {
  const location = useLocation()
  const q = new URLSearchParams(location.search).get('q')?.trim() ?? ''
  if (q === '') return <HomePage />
  return <Navigate to={`/browse?${new URLSearchParams({ q })}`} replace />
}

/** 导入跑着的时候顶栏留个入口，切走再切回来能找到它（import-ux.md §9）。 */
function ImportProgressLink() {
  const { phase, items, done } = useImport()
  const running = phase === 'uploading' || phase === 'processing'
  // 「有结论的」行数，判据和进度页那份是同一个（`isSettled`）：已上传但服务端还没给
  // 结论的行不算，否则顶栏这个数会跑到服务端前面。两处写两个口径是这类计数最常犯的错。
  const settled = items.filter((it) => isSettled(it.state)).length
  const total = done?.total ?? items.length

  if (!running || total === 0) return null

  return (
    <Button variant="ghost" size="sm" className="ml-auto tabular-nums" asChild>
      <Link to="/import">
        导入 {settled}/{total}
      </Link>
    </Button>
  )
}

/**
 * 按需加载的页面在下载期间的占位。
 *
 * **只有读屏看得见**（`sr-only`）：本地那个 chunk 是几十毫秒级的事，屏幕上闪一下
 * 「加载中…」比空着更扎眼。但也不能什么都不给——`Suspense` 确实会占掉一段时间
 * （慢网络下可能到一秒），读屏用户需要知道「刚才那一下点没点上」。
 * `role="status"` 是这一档的既有写法（同 `ImportProgress` 的重连提示）。
 */
function PageFallback() {
  return (
    <p role="status" className="sr-only">
      加载中…
    </p>
  )
}

/**
 * 登录后的外壳。2026-09-21 之前这里是顶部导航条 + `styles.css` 里一组 `.app__*`
 * 规则，现在换成 shadcn 的侧边导航（见 `components/AppSidebar.tsx`）。
 *
 * 顶栏**吸顶**（2026-09-21 改，此前故意不吸顶）：它唯一的常驻内容是折叠按钮，
 * 而不吸顶时按钮只在页面顶部可见——长页面往下一滚就再也折不动侧边栏了。
 *
 * 用 `sticky` 不用 `fixed`：`fixed` 把顶栏抽离文档流，下面那几处偏移量之外还得再补一层
 * `padding-top`，多一个会漂的量；`sticky` 的高度仍在流内，变的只是它在视口里的位置。
 *
 * 吸顶的代价是**几处「比它低」的地方**必须跟着算，全部按 `--app-header-h`
 * （`index.css` 的 `:root`，吸顶那天为它新加的一个值）：
 *   · 浏览页筛选列的 sticky `top` 与 `max-height`（`routes/browse.tsx`）
 *   · `SettingsCard` 的 `scroll-mt`（`#invites` 这类锚点的落点）
 * （**三处抽屉不在这张表里**：它们在 Radix 那一层、压得住顶栏，所以按注册表原样全高，
 * 见下面 `z-index` 那段。）
 * 再加上本条自己的高度。顶栏还得压住页面内容，所以 `bg-background` 不能省
 * ——省了不报错，是内容从顶栏底下透出来。
 *
 * ## z-index 20（2026-09-22 定；当天先从 `z-10` 抬到 9999、又落到 60，最终收到 20）
 *
 * 抬起来是修一个**真的会画错**的现象：卡片上的角标 /「⋯」/ 收藏
 * （`components/MemeCard.tsx`）也是 `z-10`，而它们 DOM 更靠后，`SidebarInset` 又只是
 * `relative`（**不构成层叠上下文**）——同一层里按 DOM 顺序比，滚动时卡片浮层会画到顶栏上面。
 * 20 > 10，这个缺陷是修好的（首页图墙那种不带 `transform` 的卡片格子上量得到）。
 *
 * **20 这个数只和两个邻居有关**，不是「越大越保险」：
 *   · 卡片浮层 `z-10`、侧边栏 `z-10`（轨道那条 `z-20` 的细线与顶栏不相交）—— 在下面；
 *   · Radix 那一层 `z-50`（手机端导航抽屉、Dialog、Sheet、Select、Popover）—— 在**上面**。
 *
 * ⚠️ **顶栏必须低于 Radix 那一层**，反过来（60 / 9999 那两版）都错过一次：顶栏一旦高过
 * 50，三处全高面板就被它切成「顶栏 + 面板」上下两条同时显示——手机端开导航抽屉时屏幕上
 * 还留着一条 56px 的顶栏和一个 ☰，产品负责人 2026-09-22 报的就是这个
 * （「和侧边栏展开有冲突，会一起显示」）。那条顶栏还是**假的**：Radix 的模态机制给 `body`
 * 挂了 `pointer-events: none`，在它上面按下命中的是遮罩、效果是**把抽屉关掉**，
 * 不是「顶栏还活着、点 ☰ 能开合导航」。
 *
 * 20 < 50 之后，三处抽屉按注册表原样全高（`inset-y-0`），遮罩也蒙住顶栏，
 * 不用再给它们各写一段 `top-(--app-header-h)`——省掉的正是那段推导。
 *
 * 全屏阅览（`components/LightboxViewer.tsx`）不受影响：`.yarl__portal` 自带 `z-index: 9999`，
 * 本来就是数值最大的那一个。
 */
function AppLayout() {
  return (
    // Radix 的 Tooltip 没有 Provider 会**直接抛错**（不是降级），
    // 而侧边栏的图标窄栏模式全靠 tooltip 显示菜单名。registry 的 SidebarProvider
    // 里不含 Provider，这一步漏了整个应用白屏。
    <TooltipProvider>
      <SidebarProvider>
        {/*
          全屏阅览挂在**这一层**，不是挂在卡片里。位置是有讲究的：它包住 `SidebarInset`，
          于是 `<Lightbox>` 的 React 祖先链只有外壳，**不经过任何页面**——否则首页那个挂在
          根 `<section>` 上的键盘 handler 会连阅览器里的 Esc / ↑↓ 一起接走
          （`components/ImageViewer.tsx` 头部有完整推导，那是本次最容易静默出错的一处）。
          `Enter` 2026-09-26（裁定 4）起不再是泄漏项，原因写在同一处，别照着这一行的键列表
          去核对。
        */}
        <ImageViewerProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="sticky top-0 z-20 flex h-(--app-header-h) shrink-0 items-center gap-2 border-b bg-background px-4">
              {/*
                44 是手机那一档的（手指按抽屉开关），鼠标那一档回到 32——
                一个 44 的方块摆在 56 高的顶栏里，四周的空比图标本身还大。
                闸门是指针不是宽度，理由同 `lib/touch.ts`。
              */}
              <SidebarTrigger className="size-11 pointer-fine:size-8" />
              {/*
                进度放顶栏而不是侧边栏：手机端（<768px）整条导航收进抽屉，
                侧边栏上的角标就看不见了，而 import-ux.md §9 要的是「切走再切回来还能看到」。
                折叠成图标窄栏时侧边栏角标同样会隐藏，顶栏是唯一两个形态下都在的位置。
              */}
              <ImportProgressLink />
            </header>
            {/* `SidebarInset` 自己就是 `<main>`，这里不能再套一层，会出现两个 main 地标 */}
            <div className="flex-1 p-6">
              {/*
                按需加载的页面在这里兜底（`Suspense` 是 `lazy` 的必需搭配，没有它整页报错）。
                边界**包 `Outlet` 而不是包整个 `Routes`**：包在外面的话，一次切页会把侧边栏
                与顶栏一起换成 fallback，整条外壳闪一下——用户看到的像是应用重开了。
                在这一层，外壳留着、换掉的只有内容区。
              */}
              <Suspense fallback={<PageFallback />}>
                <Outlet />
              </Suspense>
            </div>
          </SidebarInset>
        </ImageViewerProvider>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export function App() {
  return (
    <AuthProvider>
      {/* 导入队列挂在这里而不是 /import 里：切到搜索页时它要继续跑（import-ux.md §9） */}
      <ImportProvider>
        {/*
          全站提示挂在这一层，**在 `Routes` 之外**：登录 / 注册两条路由不带 `AppLayout`，
          挂进外壳那两页就没有提示可用（而那两页的失败态本来就在页内，见 `feedback.md`）。
          位置、层级、避开顶栏那几条都在 `components/ui/sonner.tsx` 里。
        */}
        <Toaster />
        <Routes>
          {/*
            登录 / 注册不带外壳。它们各自是一个专注任务页，旁边挂一条导航栏只是噪音；
            以前带导航是顶部条时代的遗留（那条导航在两页上也几乎全是登录后才有效的入口）。
          */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route element={<AppLayout />}>
            <Route element={<RequireAuth />}>
              <Route path="/" element={<HomeRoute />} />
              <Route path="/browse" element={<BrowsePage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            {/* 开发期才有这条路由（见文件上方 `UiPage` 的推导）。生产包里 `UiPage` 是
                `null`，真的有人手工敲 `/ui` 会落到下面的 `*` 路由，得到 404 页。 */}
            {UiPage !== null && (
              <Route
                path="/ui"
                element={
                  <Suspense fallback={null}>
                    <UiPage />
                  </Suspense>
                }
              />
            )}

            {/*
              三个管理页并进了 /settings（见 routes/settings.tsx）。旧地址保留成重定向而不是
              直接删掉：管理员的书签和文档里的链接都指着它们，404 比多留三行路由贵。
              放在布局路由**里面**——放外面的话重定向会先卸掉整条外壳再挂回来，闪一下。
            */}
            <Route path="/admin" element={<Navigate to="/settings" replace />} />
            <Route
              path="/admin/invites"
              element={<Navigate to="/settings#invites" replace />}
            />
            <Route
              path="/admin/users"
              element={<Navigate to="/settings#users" replace />}
            />
            <Route
              path="/admin/embedding"
              element={<Navigate to="/settings#embedding" replace />}
            />

            {/* `*` 路由验证「刷新任意深层 URL 不 404」，见 api/src/server.ts mountWebDist */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </ImportProvider>
    </AuthProvider>
  )
}
