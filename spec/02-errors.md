# §2 错误

[返回索引](INDEX.md)

## §2.1 结构

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "只有上传者或管理员可以删除",
    "requestId": "01JB8X...",
    "details": {}
  }
}
```

`message` 面向用户，中文，可直接展示。`details` 可选，结构随 `code` 而定，客户端按 `code` 分支处理，**不解析 `message` 文本**。

`requestId` 出现在每个错误响应和服务端日志里，排障时以它为准。

## §2.2 通用错误码

| code | HTTP | 含义 | 客户端行为 |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | 请求字段不合法或含未知字段 | 展示 `details.fields` 指出的字段问题 |
| `UNAUTHENTICATED` | 401 | 无会话或会话过期 | 跳登录页，保留当前路由用于回跳 |
| `FORBIDDEN` | 403 | 已登录但无权限 | 展示 message，不跳转 |
| `NOT_FOUND` | 404 | 资源不存在或已软删 | 展示空状态 |
| `CONFLICT` | 409 | 违反唯一约束 | 见 §2.3 |
| `QUOTA_EXCEEDED` | 413 | 超出存储配额 | 展示剩余配额并停止后续上传 |
| `RATE_LIMITED` | 429 | 触发限流 | 按 `Retry-After` 退避 |
| `INTERNAL` | 500 | 服务端异常 | 展示 requestId，提示重试 |

**软删记录返回 `NOT_FOUND` 而不是 `410`。** 对客户端而言它就是不存在，不暴露「这里曾经有东西」。

**游标类错误走 `VALIDATION_FAILED`，不新增错误码。** 游标无法解析、已过期、或与请求形态不匹配（把检索游标传给无 `q` 的列表请求，或反过来）都归它——这三种情况客户端要做的是**同一个动作**：丢弃游标、回到第一页并说明原因，所以 `details` 里不带额外信息，客户端也不区分文案。**服务端不得静默返回第一页**，理由见 [§1.3](01-http.md)。

## §2.3 导入与去重

| code | HTTP | 含义 |
|---|---|---|
| `DUPLICATE_EXACT` | 409 | 文件字节完全相同，`details.existingMemeId` 指向已有记录 |
| `UNSUPPORTED_FORMAT` | 415 | magic bytes 探测结果不是支持的图片格式 |
| `FILE_TOO_LARGE` | 413 | 单文件超限 |

批量导入时这些不作为 HTTP 错误返回，而是作为 [§1.4](01-http.md) 的 `item` 事件的 `reason` 出现——整批不会因为一个文件重复就失败。

## §2.4 AI 调用失败

这一组是本项目的特殊之处：**失败不代表请求错误，多数情况要降级而不是报错。**

| code | 含义 | 服务端行为 |
|---|---|---|
| `AI_NOT_CONFIGURED` | 主通道和部署方默认值都没有 | 图片正常入库，`tagStatus = pending` |
| `AI_REFUSED` | 供应商拒绝了内容 | 尝试副通道；仍失败则 `tagStatus = needs_manual` |
| `AI_INVALID_OUTPUT` | 返回非法 JSON 或标签不在词表内 | 重试一次；仍失败按 `AI_REFUSED` 处理 |
| `AI_UNREACHABLE` | 超时、网络错误、5xx | 重试；超过次数后回队列等待重跑 |
| `AI_UNSUPPORTED` | 模型不支持图片输入等能力问题 | 不重试，直接失败并提示用户检查配置 |

**`AI_REFUSED` 的识别有三种形态**，实现必须同时覆盖：HTTP 层的内容策略错误码、返回合法 HTTP 200 但正文是拒绝措辞、返回的 JSON 结构完整但字段为空或含拒绝文本。具体判定规则见 `api/agents/rules/ai-providers.md`；判定规则的准确性依赖 [供应商探测任务](../joint-tasks/2026-09-13-provider-spikes.md)，当前为 `proposed`。

**图片数超限不落在这张表里。** 动图一次最多发 10 张（[§9.4](09-decisions.md)），但供应商的单请求图片数上限**探测不出来**，只会在运行时报错。这种情况**先在同一通道内降到 4 帧重试，仍失败再回退拼图**，两步都失败才按上表走 `AI_UNSUPPORTED` 之外的正常降级。**不要因为它换通道**——换个供应商同样可能超限。

**即使两个通道都失败也不是全丢。** 缩略图和文件仍在，图仍能被原始文件名（`original_filename`，见 [§5.2.3](05-data-models.md)）和已有标签检索到，只是没有语义描述。降级是分级的，不是二值的。

## §2.5 配置与测试连接

| code | 含义 |
|---|---|
| `CONFIG_TEST_REQUIRED` | 未通过测试连接就尝试保存配置 |
| `EMBED_DIM_TOO_SMALL` | 实测输出维度 < 1024，`details.nativeDim` 给出实测值 |
| `EMBED_MODEL_CHANGED` | 管理员更换 embedding 模型未确认重建索引 |

测试连接本身**不通过也返回 200**，结果在响应体里。它是一次诊断，不是一次失败的操作——把模型的原始返回原样带回给用户是这个接口的核心价值，见 [§6.5](06-endpoints.md)。
