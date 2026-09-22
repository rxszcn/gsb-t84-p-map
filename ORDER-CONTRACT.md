# pMap 的三套顺序契约

复现脚本：`repro/agg-order.mjs`（`node repro/agg-order.mjs`）。
输入固定为 `["A","B","C","D"]`，mapper 耗时固定为 `A=200ms, B=10ms, C=150ms, D=5ms`。
以下读数全部来自本机实跑，不是推演。

## 一、三种顺序在四种并发下的读数

### 1. 返回值顺序（全成功路径）

| concurrency | 返回值 |
|---|---|
| 1 | `a,b,c,d` |
| 2 | `a,b,c,d` |
| 4 | `a,b,c,d` |
| `Infinity` | `a,b,c,d` |

### 2. mapper 收到的下标（mapper 被同步调用的顺序）

四种并发下完全一致：`A@0,B@1,C@2,D@3`，即下标严格等于输入下标，调用顺序也严格等于输入顺序。

原因：下标在 `next()` 里、`await iterator.next()` 返回之后由 `const index = currentIndex; currentIndex++;` 分配（`index.js` 的 `next()`）。同步数组上 `iterator.next()` 同步 resolve，启动期那批 runner 在同一个微任务批次里依次 `await` 完成，`currentIndex` 按 0,1,2,… 自增；之后每个槽位都是在上一个任务 settle 后递归调用 `next()` 补货，没有竞争窗口。所以无论几个槽位，mapper 的入参下标和首次调用顺序都不会乱。

### 3. `AggregateError.errors` 顺序（`stopOnError: false`，四个 mapper 全部抛错）

| concurrency | errors 顺序 | 个数 |
|---|---|---|
| 2 | `B,C,D,A` | 4 |
| 4 | `D,B,C,A` | 4 |
| `Infinity` | `D,B,C,A` | 4 |

（`concurrency: 1` 在该脚本里未列入这一组；它是严格串行，读数会是 `A,B,C,D`。）

**为什么并发 2 是 `B,C,D,A`，而并发 4 是 `D,B,C,A`：**

errors 是按 mapper 的 **reject 实际发生时刻** `push` 的，不是按下标。

- 并发 2：t=0 只有 A、B 两个槽位起跑。B 在 t=10 先 settle，槽位空出，C 在 t≈10 才被取出并起跑；随后 C 槽在 t≈10+10（取 D 的微任务排在 B 的 catch continuation 之后，约 t=10 稍后）取出 D。实际 settle 时刻：B≈10 < C≈160 < D≈15+排队偏移 < A=200，读数为 `B,C,D,A`。
- 并发 4 / Infinity：四个任务 t=0 全部起跑，settle 时刻就是各自耗时：D=5 < B=10 < C=150 < A=200，读数为 `D,B,C,A`。

两组的差别只来自一件事：并发 2 下 C、D 的起跑被槽位释放推迟了，而并发 4 下它们在 t=0 就起跑。push 的排序键是“完成时刻”，所以排程差异直接变成 errors 顺序差异。

**为什么返回值四种并发下都不变：** 返回值走的是按索引槽位写入（见第二节），写得再晚也落在自己的 `result[index]` 上；errors 走的是纯时序追加数组。两条写入路径根本不是同一套顺序机制。

### 4. `stopOnError: true` 时抛出的东西

| concurrency | 构造器 | message |
|---|---|---|
| 1 | `Error` | `e:A` |
| 2 | `Error` | `e:B` |
| 4 | `Error` | `e:D` |
| `Infinity` | `Error` | `e:D` |

抛的是**第一个 settle 的 reject 原样透传**，不包 `AggregateError`：每个 detached runner 的 catch 里调用 `reject(error)`，`reject` 内部用 `isResolved` 幂等闸门保证只有第一个生效。并发 1 下 A 是唯一在跑的；并发 2 下 B(10ms) 先于 A(200ms)；并发 4/Infinity 下 D(5ms) 最先。这同样是“完成时刻”排序，和 errors 数组同一时钟，只是只取第一名。

## 二、两处写入分别是谁、在什么时机写的

- **返回值顺序的保证者：`result[index] = value`（`index.js`，`next()` 内 detached IIFE 中 mapper `await` 成功之后）。** 写入时机是该元素的 mapper **fulfill 的那一刻**，但写的是输入下标 `index` 对应的固定槽位，而不是 `result.push(...)`。数组槽位写入与完成顺序无关，数组天然有洞也无所谓，最后 `resolve(result)` 直接交出这个稀疏数组。这同时对应 `readme.md:42` 的明文承诺：“fulfilled value is an `Array` … in `input` order”。即：输入序由“按索引槽位写”这一行代码保证，文档也把它列为对外承诺。
- **errors 入数组的位置：`errors.push(error)`（`index.js`，同一个 detached IIFE 的 `catch` 分支，仅 `stopOnError === false` 时）。** 写入时机是该元素的 mapper（或输入元素自身的 promise）**reject 被 await 观察到的那一刻**，谁先 settle 谁先 push，没有任何按 index 排序或预占槽位的逻辑。数组只在终局被读取一次：最后一个槽位完成、`next()` 再次拉取拿到 `done` 且 `resolvingCount === 0` 时，在 done 分支里 `reject(new AggregateError(errors))`。
- 下标本身的分配是第三处、更早的时机：`const index = currentIndex; currentIndex++;`，发生在取出元素时、mapper 被调用之前。

所以同一批输入经过三条独立通道：下标在“取出时”按序分配，返回值在“成功时”按槽位归位，errors 在“失败时”按完成时刻排队。

## 三、现有用例为什么测不到这条契约，怎么改才能测到

`test.js:469` 的用例 `aggregates rejected input elements when stopOnError is false` 断言：

```js
t.deepEqual(error.errors.map(error => error.message), ['input 0', 'input 2']);
```

它的输入是两个**构造时就已 reject 的 Promise**：

```js
[Promise.reject(new Error('input 0')), 1, Promise.reject(new Error('input 2')), 3]
```

这测不出“errors 按完成时刻排序”这条契约，因为这两个 reject 在 pMap 开始迭代之前就已经全部 settle，且下标 0 先于下标 2 被取出、先被 `await` 观察到。不管实现是“按完成时刻 push”还是“按输入下标排序/槽位收集”，这个用例的读数都一样——完成时刻的先后在这里恰好与输入序重合。实跑验证：把这个输入原样搬到 `concurrency` 1/2/4/`Infinity` 四档，读数全部是 `input 0,input 2`。并发怎么改都测不出来。

要测出区别，必须让两个 reject 的**完成时刻先后与输入下标相反**。两种最小改法（均已实跑）：

1. 改延时——把预 reject 换成错时 reject（0 慢、2 快）：

   ```js
   const rejectAfter = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));
   const input = [rejectAfter(50, 'input 0'), 1, rejectAfter(5, 'input 2'), 3];
   ```

2. 改延时——普通值输入，让 mapper 错时抛错：

   ```js
   async value => {
       if (value === 0) { await delay(50); throw new Error('input 0'); }
       if (value === 2) { await delay(5);  throw new Error('input 2'); }
       return value;
   }
   ```

两种改法在 `concurrency: 2` 和 `concurrency: 4` 下实跑读数一致：

```
input 2,input 0
```

即当前实现给出的是完成时刻序（2 先 reject 先 push），而不是输入序。若用例继续断言 `['input 0', 'input 2']`，在这种改法下就会失败——这才是真正在约束顺序契约的断言。（只改并发、不改预 reject 的延时形态则永远测不到，因为预 settle 的输入没有时序差。）

## 四、收口：这算缺陷还是契约，判据落在哪一层，牵连哪些用例，我的选择

判据分层：

- **语言层（`AggregateError`）不规定顺序。** ECMA-262 对 `errors` 列表只有“可枚举、按给定顺序保存”的容器语义，调用方给什么顺序就是什么顺序。所以“是不是缺陷”无法在语言层判。
- **API 文档层（`readme.md`）只承诺了成功侧。** `readme.md:42` 明确承诺返回值“in `input` order”；`readme.md:104` 对 `stopOnError: false` 只说“reject with an AggregateError containing all the errors”，对 errors 的顺序一个字都没写。文档层没有输入序承诺，也没有完成时刻序承诺。
- **实现层（`index.js`）有确定行为。** `errors.push(error)` 的写法等价于一个明确的、可复现的规则：**按 reject 被观察到的完成时刻升序**。它与 `stopOnError: true` 抛“最先完成的 reject”用的是同一个时钟，语义自洽。

两种定性各自牵连的现状：

- 若判为**契约**（完成时刻序）：现有 82 条用例无需改动；唯一断言 errors 内容顺序的用例 `test.js:469`（以及它依赖的预 reject 形态）恰好不构成反例，但也不构成有效保护，应补一条第三节那样的错时用例把契约钉死。风险是下游若误以为 errors 与输入对齐，会在并发下踩坑。
- 若判为**缺陷**（期望输入序）：修法是给错误也按 index 槽位收集（类似 `result[index] = error` 或 `{index, error}` 排序），这会改变 `repro/agg-order.mjs` 中并发 2 的 `B,C,D,A` 和并发 4 的 `D,B,C,A` 两组读数；现有用例不会变红（唯一的顺序断言 `test.js:483` 在两种语义下都成立，这正是它测不出契约的原因），但第三节那种错时场景的预期要按输入序重写。

**我选契约这一边。** 理由：文档对错误顺序未作任何承诺，而实现行为确定、可复现，且与库内另一条对外语义（`stopOnError: true` 透传最先完成的错误）共用同一个“完成时刻”排序键，自洽且零迁移成本；`Promise.allSettled` 等基元的结果集合同样不保证按完成时刻以外的顺序，调用方需要稳定顺序时应自行用输入下标配对，而不是依赖 push 顺序。需要做的不是改代码，而是把这条未成文规则像本文第一节这样落成明文，并补一条错时 reject 的用例防回归。
