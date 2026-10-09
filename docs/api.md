# 模块接入

构建命令：`npm run build:core`。输出 `dist/index.js` 及 TypeScript 类型声明；应用需通过 HTTP 服务提供整个 `dist/`，保留模块间的相对路径。直接作为浏览器 ES Module 导入，或由应用自己的构建工具打包源码。

## 挂载

在页面主体加载后调用：

```js
import { mountEdgekin } from './dist/index.js';

const game = mountEdgekin({
  root: document.body,
  onComplete() {
    console.log('Completed');
  },
});

await game.start();
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `root` | `HTMLElement`，可选 | 扫描范围，默认 `document.body`；地图仍位于当前视口 |
| `onComplete` | `() => void`，可选 | 每次完成关卡时调用 |

画布和控件挂载在 `document.body` 下的独立 Shadow DOM 中。画布不拦截鼠标，游戏运行期间使用方向键；宿主输入框获得焦点时暂停。

## 实例方法

| 方法 | 返回值 | 行为 |
| --- | --- | --- |
| `start()` | `Promise<void>` | 没有地图时异步生成并开始；已暂停的关卡继续运行 |
| `pause()` | `void` | 停止动画和当前按键输入；生成中调用可取消自动开始 |
| `restart()` | `void` | 回到当前关卡原起点，保持暂停，不重新扫描 |
| `regenerate()` | `Promise<void>` | 重新扫描和选关，完成后保持暂停 |
| `getMapStats()` | `MapStats \| null` | 返回当前统计；读取统计不会扫描页面 |
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

宿主页面退出、路由卸载或移除功能时，应调用 `game.destroy()`。重叠生成会取消过期任务；页面没有合格路线时显示无法生成提示，Promise 的完成不代表必定生成可玩的地图。

## 诊断统计

`getMapStats()` 的类型定义见 [`src/index.ts`](../src/index.ts)。包括：

- 轮廓：`outlineCount`、`eligibleOutlineCount`、`omittedOutlineCount`、`complexityPercent`、图标与开口数量。
- 路线：跳跃、墙跳、蹲行次数，平台和分支数量，起终点距离、最小落点余量、扰动成功比例及估计执行时间。
- 生成：扫描各阶段、规划和总耗时，以及重试次数。
- 运行：最近 120 个动画帧的样本数量、平均 FPS、帧间隔 P95、平均物理更新与绘制耗时。

未生成地图时返回 `null`；没有相应运行样本的指标也可能为 `null`。统计反映当前设备上的采样结果，不是跨设备性能保证。

## 排除特定页面元素

可在不希望参与地图识别的元素上标记 `data-edgekin-ignore`：

```html
<aside data-edgekin-ignore>此区域不参与地图识别</aside>
```

该区域及其后代不参与轮廓提取。Edgekin 自己的界面也使用此标记，避免被当作网页地形。
