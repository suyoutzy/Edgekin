# 模块接入

构建命令：`npm run build:core`。输出 `dist/index.js` 及 TypeScript 类型声明；应用需通过 HTTP 服务提供整个 `dist/`，保留模块间的相对路径。直接作为浏览器 ES Module 导入，或由应用自己的构建工具打包源码。

## 挂载

在页面主体加载后调用：

```js
import { mountEdgekin } from './dist/index.js';

const game = mountEdgekin({
  root: document.body,
  mode: 'collect',
  hazards: true,
  onCollect(score) {
    console.log('Score:', score);
  },
});

await game.start();
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `root` | `HTMLElement`，可选 | 扫描范围，默认 `document.body`；地图仍位于当前视口 |
| `mode` | `'collect' \| 'course'`，可选 | 默认连续收集；`course` 使用原起终点通关玩法 |
| `hazards` | `boolean`，可选 | 收集模式默认允许巡逻障碍；`false` 可对比无障碍体验；通关模式不添加巡逻障碍 |
| `onCollect` | `(score: number) => void`，可选 | 每枚硬币成功收集后调用，传入累计分数 |
| `onComplete` | `() => void`，可选 | 仅通关模式完成关卡时调用 |

画布和控件挂载在 `document.body` 下的独立 Shadow DOM 中。画布不拦截鼠标，游戏运行期间使用方向键；宿主输入框获得焦点时暂停。

## 实例方法

| 方法 | 返回值 | 行为 |
| --- | --- | --- |
| `start()` | `Promise<void>` | 没有地图时异步生成并开始；已暂停的关卡继续运行 |
| `pause()` | `void` | 停止动画和当前按键输入；生成中调用可取消自动开始 |
| `restart()` | `void` | 回原起点并暂停，不扫描；收集模式清零并异步选择新硬币 |
| `regenerate()` | `Promise<void>` | 重新扫描和选关，完成后暂停；保留本实例的收集分数 |
| `getMapStats()` | `MapStats \| null` | 返回当前统计；读取统计不会扫描页面 |
| `getSessionStats()` | `SessionStats` | 返回模式、状态、分数、游戏时间、目标、返回点、人物与巡逻物位置 |
| `destroy()` | `void` | 移除界面，取消生成和动画，释放定时器、观察器与事件监听 |

重新生成后开始：

```js
await game.regenerate();
await game.start();
```

重试同一地图：

```js
game.restart();
await game.start();
```

`restart()` 在收集模式下会清零。若只想继续暂停的游戏，直接调用 `start()`。自然掉落或触碰障碍会自动返回最近收集位置，保留分数；该行为不调用 `restart()`。

如需原版接入行为：

```js
const game = mountEdgekin({ mode: 'course', onComplete() { console.log('Completed'); } });
```

0.3.0 的默认模式改变为 `collect`；原来依赖 `onComplete` 的宿主应显式设置 `mode: 'course'`。

宿主页面退出、路由卸载或移除功能时，应调用 `game.destroy()`。重叠生成会取消过期任务；页面没有合格路线时显示无法生成提示，Promise 的完成不代表必定生成可玩的地图。

## 诊断统计

`getMapStats()` 的类型定义见 [`src/index.ts`](../src/index.ts)。包括：

- 轮廓：`outlineCount`、`eligibleOutlineCount`、`omittedOutlineCount`、`complexityPercent`、图标与开口数量。
- 补充地形：`gapPlatformCount`；紫色空白区平台不计入网页轮廓覆盖率。
- 路线：跳跃、墙跳、蹲行次数，平台和分支数量，起终点距离、最小落点余量、扰动成功比例及估计执行时间。
- 生成：扫描各阶段、规划和总耗时，以及重试次数。
- 运行：最近 120 个动画帧的样本数量、平均 FPS、帧间隔 P95、平均物理更新与绘制耗时。

尚未扫描或已销毁时返回 `null`；选关失败时仍可能返回本次扫描统计。没有相应运行样本的指标也可能为 `null`。统计反映当前设备上的采样结果，不是跨设备性能保证。

收集模式的路线统计随当前目标更新，来自完整动作重放；操作扰动比例和落点最小余量暂为 `null`。候选采样较多不代表玩家必须执行所有动作。

`getSessionStats()` 返回新的数据对象，不会推进游戏、触发扫描或修改内部状态。`elapsedSeconds` 只在实际运行物理时增加，暂停及选择目标时冻结；`targetSelectionMs` 是最近一次收集后的目标选择耗时，未发生时为 0。选目标期间状态为 `selecting`，动作暂时停住，输入焦点、暂停和销毁仍生效。

分数只在当前挂载实例内累计，不写入浏览器存储。宿主可通过 `onCollect` 自行保存成绩。

## 排除特定页面元素

可在不希望参与地图识别的元素上标记 `data-edgekin-ignore`：

```html
<aside data-edgekin-ignore>此区域不参与地图识别</aside>
```

该区域及其后代不参与轮廓提取。Edgekin 自己的界面也使用此标记，避免被当作网页地形。
