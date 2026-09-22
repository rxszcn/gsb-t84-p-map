# pMap 的三套顺序：实测契约

复现脚本：`repro/agg-order.mjs`（`node repro/agg-order.mjs`）。输入固定为
`["A", "B", "C", "D"]`，各元素在 mapper 里的耗时为 `A:200ms, B:10ms, C:150ms, D:5ms`。
以下全部读数连跑两遍逐字一致，与定时器抖动无关。

## 一、四种并发下的三组读数

### 返回值顺序与 mapper 收到的 index（mapper 不抛错时）

| concurrency | 返回值 | mapper 第二参数（按调用先后） |
| --- | --- | --- |
| `1` | `a,b,c,d` | `A@0,B@1,C@2,D@3` |
| `2` | `a,b,c,d` | `A@0,B@1,C@2,D@3` |
| `4` | `a,b,c,d` | `A@0,B@1,C@2,D@3` |
| `Infinity` | `a,b,c,d` | `A@0,B@1,C@2,D@3` |

三组里这两组在四种并发下完全相同：mapper 的第二参数是**拉取顺序**（0,1,2,3），
返回值是**输入下标顺序**（a,b,c,d）。并发只改变谁先跑完，不改变这两者。

### `stopOnError: true`（默认）抛出的是哪一条

| concurrency | 抛出 |
| --- | --- |
| `1` | `Error: e:A` |
| `2` | `Error: e:B` |
| `4` | `Error: e:D` |
| `Infinity` | `Error: e:D` |

抛的是**第一个落进 catch 的 rejection**（完成顺序的第一名），不是下标最小的那一条：
c=1 只有 A 在跑，只能是 A；c=2 先跑 A、B，B 只睡 10ms，B 先抛；c≥4 时四个任务同批
起跑，D 只睡 5ms 最先抛。

### `stopOnError: false` 时 `AggregateError.errors` 的顺序

| concurrency | `errors[]`（message 去 `e:` 前缀） | 个数 |
| --- | --- | --- |
| `1`（脚本未打印，另测） | `A,B,C,D` | 4 |
| `2` | `B,C,D,A` | 4 |
| `4` | `D,B,C,A` | 4 |
| `Infinity` | `D,B,C,A` | 4 |

这是**结算顺序（settlement order）**，即每个 rejection 被 `await` 抛出、进入 catch 的先后，
不是输入下标顺序。按时间线展开：

- c=1：串行，A 完→B 完→C 完→D 完，结算序就是 `A,B,C,D`。
- c=2（元素与槽位一一对应）：起跑槽1=A(200)、槽2=B(10)。t=10 **B** 错（1），
  槽2 拉到 C(150)；t=160 **C** 错（2），槽2 拉到 D(5)；t=165 **D** 错（3）；t=200
  **A** 错（4）。→ `B,C,D,A`。（C 从 t=10 才开始睡 150ms，所以它在 A 之前结算。）
- c=4 与 `Infinity`：四个任务同批起跑，结算时刻就是各自耗时：D(5)、B(10)、C(150)、
  A(200) → `D,B,C,A`。

**为什么 c=2 与 c=4 不同**：c=4 时 C、D 在 t=0 就和 A、B 同批起跑，完成时刻等于自身
耗时；c=2 时 C 要等 B 在 t=10 让出槽才开始（完成时刻被推迟到 t=160），D 又要等 C 在
t=160 让出槽（完成时刻 t=165）。槽位把 C、D 的起跑推迟了，于是入列序从"自身耗时序"
`D,B,C,A` 变成了"槽位接力序" `B,C,D,A`。

**为什么返回值四种并发都不变**：返回值从来不按完成顺序拼，而是按下标直接写槽位
（见第二节）。谁先完成只决定 `result[index]` 被写入的先后，数组读出来永远是
`result[0], result[1], …`。

## 二、两处写入点：谁保证返回值顺序，错误在哪一步进数组

都在 `index.js` 的 `pMap` 内：

1. **下标的分配**——`next()` 从迭代器同步取到一项后立刻执行 `const index = currentIndex;
   currentIndex++;`（`index.js:78-79`），随后 detached IIFE 里才是
   `const value = await mapper(element, index)`（`index.js:131`）。所以 index 在 mapper
   被调用之前就按拉取顺序定死了；mapper 第二参数恒为 0,1,2,3，与耗时、并发无关。
2. **返回值的写入**——mapper 成功后执行 `result[index] = value`（`index.js:138`）。
   这是"按下标写槽位"，不是 push：D 先完成只写 `result[3]`，绝不占据 `result[0]`。
   全部结算后在 done 分支 `resolve(result)`（无 `pMapSkip` 时 `index.js:99`；有 skip
   时按 entries 顺序过滤后 `resolve(pureResult)`，`index.js:106-114`）。**返回值顺序由
   `result[index] = value` 这一写入方式保证**，readme 也把它写成了外部契约：
   "fulfilled value is an Array … in `input` order"（`readme.md:42`，`index.d.ts:74`
   同文）。写入时机：每个 mapper 成功结算的那一刻，整体结果在最后一个 runner 拉到
   done 且 `resolvingCount === 0` 时才 resolve（`index.js:90-99`）。
3. **错误的写入**——失败路径在同一个 detached IIFE 的 catch 里：`stopOnError` 为真时
   `reject(error)`（`index.js:140-142`）；为假时 `errors.push(error)`
   （`index.js:145`）。注意 errors 用的是 **push**，与 result 的"按下标写槽"正好相反：
   它不记录 error 属于哪个下标，谁的 rejection 先被 catch 到谁排前面。**写入时机：
   mapper（或输入元素的 `await nextItem.value`）reject、在该 runner 的微任务里被
   catch 的那一刻**；最终 done 分支把这个数组原样包进
   `new AggregateError(errors)`（`index.js:91-92`），不再排序、不补下标。

一句话：`result` 是 index-ordered（稀疏数组槽位），`errors` 是 push-ordered（结算序），
index 本身是 pull-ordered（拉取序）。三套顺序来自三种不同机制。

## 三、现有用例为什么测不到这条契约，怎么改才能测到

用例：`test.js` 中的 `aggregates rejected input elements when stopOnError is false`
（`test.js:470-484`），断言 `errors` 为 `['input 0', 'input 2']`。

它的输入是两个**构造即 reject、且 reject 发生在 pMap 拿到它们之前就已经定局**的
promise。脚本最后一段把同一场景原样跑出来：

```
源自带 reject 时 errors[] input 0,input 2 | 进 mapper 的值 1,3
```

测不到契约的原因：rejection 已经 settle，handler 一挂上去就会按**挂 handler 的顺序**
（也就是 pMap 拉取/await 的下标顺序 0→2）进 catch。此时"输入下标顺序"与"结算顺序"
恰好重合，断言 `['input 0','input 2']` 在两种语义下都成立，无法区分 pMap 到底是
"按下标聚合"还是"按结算先后 push"。我实测验证了这个混淆：

- 只改并发：c=1 / c=2 / c=4 / c=Infinity 全部仍是 `input 0,input 2`（已 settle 的
  rejection，入列序只取决于谁先 await 到它，即拉取序）——所以**单改并发测不出来**。
- 把输入的 reject 改成不同延时（`input 0` 延迟 50ms reject，`input 2` 延迟 10ms
  reject），并发仍为 2：实测 **`errors[] = input 2,input 0`**（进 mapper 的值仍是
  `1,3`）。下标大的反而排第一，证明实现是结算序而非输入序。
- 同样延时但并发 1（串行）：实测 `input 0,input 2`——串行会把契约重新伪装成下标序，
  所以并发必须 ≥2。
- 另一条路：输入全给普通值，让 mapper 自己按不同延时抛错（耗时 0:50/1:5/2:20/3:1ms，
  c=4）：实测 `errors[] = mapper 3,mapper 1,mapper 2,mapper 0`，而 mapper 调用序仍是
  `0,1,2,3`——调用序、下标序、错误序三者彻底分开，这是最干净的测法。

也就是说，想让这条用例真正锁住契约，要么给输入 promise 加上**不相等的 reject 延时并
保持 concurrency ≥ 2**（断言随之改为 `['input 2', 'input 0']`），要么改成 mapper 内部
按元素延时抛错；只动 concurrency 或只在 c=1 下跑都不行。

## 四、收口：缺陷还是契约，判据落在哪一层，牵连哪些用例

**判据落在 pMap 自己这一层，且分两个维度看：**

- 返回值顺序：readme 与 `index.d.ts` 明文承诺 `input` order（`readme.md:42`、
  `index.d.ts:74`），实现用 `result[index] = value` 兑现——这是**文档化契约**，无争议。
- `errors` 顺序：readme 对 `stopOnError: false` 只说 "reject with an AggregateError
  containing all the errors"（`readme.md:104` 一带），**没有承诺任何顺序**。所以它不是
  "违反文档的缺陷"，而是"实现的可观察行为"：`errors.push(error)` 给出的结算顺序。
  语言层的 `AggregateError` 和 `Promise.allSettled` 也不替它背书（`allSettled` 按下标，
  pMap 的 errors 不按——这恰好说明顺序语义只能由库自己定）。

两种说法各自牵连的现状：

- **若判它是缺陷**（用户直觉常与返回值对称地期待 input order）：修复需要把 push 换成
  按下标暂存（类似 `result[index]`），并过滤输入元素 reject 与 mapper reject 的位置
  差异。现有用例里直接断言 errors 内容的只有 `test.js:483` 这一条，而它恰好两种语义
  下都通过，改实现不会让它变红；`test.js:171-174` 与 `test.js:307-310` 只断言
  `instanceOf: AggregateError`、不断言顺序，也不受影响；其余 stopOnError 相关用例
  （如 `test.js:1337`、`test.js:1439`）同样只看类型。换句话说：**修这个"缺陷"零现有
  测试阻力，但也意味着在给一个文档没写过的行为补契约，属于行为变更（semver minor 起步，
  谨慎应按 major 对待）。**
- **若判它是契约（我的选择）**：结算顺序是 `errors.push` 的直接、确定性后果，与
  "first mapper rejection will be rejected back"（`readme.md:102`）的"先完成先处理"
  哲学一致，也与 c=2/c=4 下 stopOnError=true 抛不同错误的行为同源；下游若已按"错误
  出现先后"消费 errors，改成下标序反而是破坏。当前全部 82 条用例与该行为相容。

**我的结论：定为契约（现状行为），但承认它是"未文档化契约"，应补文档而非改实现。**
理由：其一，返回值顺序有明文承诺而错误顺序没有，"与返回值对称"只是期待不是依据；
其二，现有行为确定、可复现、与 stopOnError=true 的 first-settlement 语义自洽；其三，
没有任何一条用例能区分两种语义（第三节），说明它从未被库当作可违反的实现细节去改，
贸然"修复"只会无测试保护地改变可观察行为。落地上建议两件小事（本任务不做）：在
`readme.md` 的 stopOnError 段写明 "errors are in settlement order, not input order"，
并把 `test.js:470` 那条用例按第三节的延时方案改成能真正卡住顺序的版本。

---

实测环境：Node v22，`node repro/agg-order.mjs` 连跑两遍读数一致；测试基线
`npx ava test.js` = 82 tests passed。
