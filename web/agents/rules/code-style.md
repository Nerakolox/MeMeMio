# 代码风格

通用写作规则见 [共用规则](../../../agents/rules/INDEX.md)。

## TypeScript

`strict: true`。禁止 `any`，禁止 `as` 强转接口返回值。

**接口类型从 `api` import，不手写。** 手写一份就意味着接口改了这边不报错，[类型同步](../../../AGENTS.md)的全部价值都在于此。

## 组件

函数组件 + hooks。

**一个组件做一件事。** 超过 150 行先想想能不能拆——不是行数洁癖，是超过这个长度之后「这个 state 影响哪块 UI」就需要上下翻了。

props 显式声明类型，不用 `React.FC`。

## 状态

见 [state-navigation.md](state-navigation.md)。一句话：**能放 URL 的放 URL，能从服务端派生的不存本地。**

## 异步与加载态

每个异步操作都要有三态：loading / error / success。**不要只写 success 那条**。

本项目的错误态尤其重要：AI 未配置、搜索降级、导入部分失败——这些都不是"错误页"，是**需要告诉用户但不阻断操作**的状态。见 [http.md](http.md)。

## 副作用

`useEffect` 只用来同步外部系统（订阅 SSE、注册键盘监听、设置 document.title）。

**不用 `useEffect` 做数据派生**——那应该直接在渲染时算，或者用 `useMemo`。

清理函数必须写。SSE 订阅和键盘监听不清理会在路由切换后继续跑。

## 注释

写为什么，不写做了什么。

本端有几处「看起来能简化但简化了就坏」的地方，必须有注释指向来源：

```tsx
// 动图写不进剪贴板，只能走下载。见 SPEC §9.2
if (meme.isAnimated) return downloadFlow(meme)
```

```tsx
// 服务端 RRF 已排好序，不要按 matchedBy 重排。见 SPEC §6.3.1
{items.map(...)}
```

## 无障碍与键盘

搜索结果支持 `↑` `↓` 选择、`Enter` 复制、`Esc` 关闭。

**这不是可选的锦上添花**——这个工具的使用场景是「聊天到一半切过来找图」，快是核心体验。鼠标操作已经比桌面端慢了，键盘路径不能再丢。

图片必须有 `alt`，用 `description` 或文件名。
