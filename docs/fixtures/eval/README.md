# 评测集 · 标注

设计依据见 [`docs/eval.md`](../../eval.md)。任务进度见 [评测集任务](../../../joint-tasks/2026-09-13-eval-set.md)。

## 这里有什么

| 文件 | 内容 | 进不进仓库 |
|---|---|---|
| `manifest.json` | 30 张图的期望值与查询 | **进**，它是项目核心资产 |
| `images/` | 图片本体 | **不进**，见 [`.gitignore`](../../../.gitignore) 与 [`docs/fixtures.md`](../../fixtures.md) |

> ⚠️ **图片不进仓库不是洁癖。** 这批图里有 7 张是故意挑的擦边内容（`cover` 里带 `擦边` 的那些），仓库一旦公开就收不回来了。图片走 R2 的私有前缀，`manifest.json` 只留文件名。

## `manifest.json` 现在还不能用

`status` 是 `draft-unreviewed`。里面每一条的 `expect` 和 `queries` 都是 AI 看图起草的，**没有经过人工校对**。

**在校对之前它不是基准，是一份待改的草稿。** 用它跑出来的分数只说明「模型和起草它的 AI 看法一致」，不说明任何别的事。

### 怎么校对

逐条过，重点在这三处，按重要性排序：

1. **`queries` —— 最重要，也最需要你本人。** 「你会用什么话去搜这张图」只有这个库的实际使用者知道答案。AI 写的 query 偏书面、偏描述画面，真实的搜索词更短、更口语、更常直接引用图上的字。这一栏改动应该最大。
2. **`emotions` / `scenes` —— 看有没有漏掉那一层反差。** 起草时对「语气微妙」类倾向于标字面情绪。`332` 标的是委屈，但它其实是撒娇式指责；`698` 标的是假笑，但也可能就是单纯开心。**这类分歧本身就是评测要测的东西**，你的判断就是答案。
3. **`humanName` —— 现在只填了 2 条，几乎肯定漏了。** 只要你看一眼就能叫出角色名或梗名，就填上。它在评测里的用法是反的（见 `docs/eval.md` §3）：模型说出它算污染，检索搜不到它算缺口。填得越全，别名层的收益基线越准。

`notes` 和 `cover` 不用改，那是选图理由，不是期望值。

> ⚠️ **扫一眼点头 = 没有校对。**
>
> 如果通读一遍觉得「差不多都对」，那多半是因为它读起来很像你会写的东西 —— AI 起草的文本天然有这个效果。至少要真的改掉一部分才算过。**改完把 `status` 改成 `reviewed` 并 bump `version`。**

## 词表合规是硬性的

`expect` 里的 `emotions` / `scenes` / `tags` **必须全部落在 [`shared/vocab/vocab.json`](../../../shared/vocab/vocab.json) 里**，否则「词表合规率」这个指标从基准这一侧就已经是脏的。

改完跑一遍：

```bash
python -c "
import json
m=json.load(open('docs/fixtures/eval/manifest.json',encoding='utf-8'))
v=json.load(open('shared/vocab/vocab.json',encoding='utf-8'))
E,S=set(v['emotions']),set(v['scenes'])
T=set(v['tags']['subject'])|set(v['tags']['style'])
bad=[(i['file'],k,x) for i in m['items'] for k,ok in
     (('emotions',E),('scenes',S),('tags',T)) for x in i['expect'][k] if x not in ok]
print(bad or 'OK', len(m['items']))"
```

> 起草这份草稿时，这个检查抓出了 **10 处违规**，全部是把 `讨好` `看戏` `撒娇` `心虚` 这类词填进了 `scenes`。
>
> **这不是手滑，是词表设计暴露出的问题**：情绪和场景的边界并不自明，「讨好」既像一种情绪也像一个使用场合。起草者对着词表都会填错，模型只会错得更多。记为 [词表任务](../../../joint-tasks/2026-09-13-vocab-v1.md) 的输入。

## 选出来的 30 张证实了两件事

跑完 `manifest.json` 的统计，两个此前只是推测的判断变成了实测：

| 观察 | 数字 | 后果 |
|---|---|---|
| `tags.subject` 全部是同一个值 | **动漫角色 30/30** | 标签过滤那一路在这个库里**没有区分度**，三路混合实际退化成两路。这不是选图偏差，是库的真实构成 |
| `tags.style` 也高度集中 | 动漫 25/30 | 同上 |
| 但 `无文字` / `带字幕` 有信号 | 15 / 9 | 这一对是 `tags` 里唯一还有用的：它直接告诉你这张图**该走哪条检索通路** |

第一行动摇的是 [SPEC §9.10](../../../spec/09-decisions.md) 三路混合的前提，交给 [词表任务](../../../joint-tasks/2026-09-13-vocab-v1.md)；第三行说明 `style` 里的这组词值得单独保住，不要在精简词表时一起砍掉。
