// 图标辅助：所有图标定义在 index.html 的 #i-sprite 中，这里只负责生成 <use> 引用。
export function icon(name, cls = '') {
  return `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
