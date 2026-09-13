# 代码风格

通用写作规则见 [共用规则](../../../agents/rules/INDEX.md)。这里只讲 `api` 的代码。

## TypeScript

**`strict: true`，不关。**

禁止 `any`。第三方返回的未知结构用 `unknown` + 运行时校验，**不要 `as` 强转**——`as` 是把类型检查关掉，不是把类型改对。

`!` 非空断言只允许出现在启动时已校验过的环境变量上，其余地方一律显式判空。理由见 [env-validation.md](env-validation.md)。

## 错误处理

**不吞错误。** `catch` 里至少要做一件事：转成业务错误、记日志再抛、或降级并记录降级原因。

```ts
// ✗ 最糟糕的写法
try { await tag(img) } catch {}

// ✓ 降级是有意的，那就写出来
try {
  return await primary.tag(img)
} catch (e) {
  log.warn({ err: e, memeId }, 'primary vision channel failed, trying fallback')
  return await fallback.tag(img)
}
```

本项目大量使用降级，**「静默降级」和「吞错误」看起来一模一样**。区别只在有没有留下记录——所以每次降级必须记日志，见 [error-handling.md](error-handling.md)。

## 异步

全用 `async/await`，不写 `.then` 链。

批量操作用 `Promise.allSettled` 而不是 `Promise.all`——**一张图打标失败不该让整批失败**，这是导入流程的基本要求。

对外部服务的调用（AI、R2）必须有超时。没有超时的 `fetch` 在中转服务卡住时会把队列 worker 挂死。

## 命名

遵循 [SPEC §7](../../../spec/07-naming.md)。三个额外约定：

- 会抛权限错误的函数用 `assertXxx`，返回布尔的用 `canXxx`。**两者不要混**——`if (assertCanMutate(...))` 这种写法说明作者以为它返回布尔。
- 返回可能为空的用 `findXxx`，找不到就抛的用 `getXxx`。
- 带 `Raw` 后缀的是未经序列化的数据库行，**不能直接返回给客户端**（它带着 `contentHash`、`embedding`、`storageKey`）。

## 注释

写为什么，不写做了什么。

本项目有大量「看起来多余但删了就出事」的代码——重新归一化、`deleted_at is null`、pHash 不设唯一约束。**这些地方必须有注释指向 SPEC 的对应章节**，否则下一个人会当成冗余删掉：

```ts
// 截断后必须重新归一化，否则余弦相似度静默失真。见 SPEC §9.6
return l2Normalize(vec.slice(0, 1024))
```

## 日志

结构化，第一个参数是对象，第二个是消息：

```ts
log.info({ requestId, memeId, model }, 'tagging completed')
```

**永远不记 API Key、`CONFIG_ENC_KEY`、会话 token。** 记模型的原始返回时要注意，它可能包含用户上传的内容。

每条错误日志必须带 `requestId`，它是 [SPEC §2.1](../../../spec/02-errors.md) 里返回给用户的那个。
