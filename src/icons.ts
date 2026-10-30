// 源文件：app 运行时使用 app/js/icons.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/icons.js。
// 图标辅助：所有图标定义在 index.html 的 #i-sprite 中，这里只负责生成 <use> 引用。
export function icon(name: string, cls: string = ''): string {
  return `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
