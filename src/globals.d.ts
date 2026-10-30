// 运行时全局：Tauri 注入对象、测试钩子，以及迁移期对 DOM 的动态属性访问。
interface Window {
  __TAURI__?: any;
  __TAURI_INTERNALS__?: any;
  __lbsh?: any;
  [key: string]: any;
}

interface Element {
  [key: string]: any;
}

interface HTMLElement {
  [key: string]: any;
}

interface EventTarget {
  [key: string]: any;
}
