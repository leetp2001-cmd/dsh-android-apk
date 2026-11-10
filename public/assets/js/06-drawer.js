/**
 * 移动端抽屉：侧栏的开合。
 *
 * 手机上侧栏不是常驻布局，而是一个覆盖层。桌面靠 CSS 断点，这里只管
 * 状态类名 —— 两套机制不要互相猜测。
 */

"use strict";

// ---------- 移动端抽屉 ----------
const sidebar = $("sidebar"), drawerMask = $("drawer-mask");
function toggleDrawer(open) {
  sidebar.classList.toggle("open", open);
  drawerMask.classList.toggle("show", open);
}
$("btn-menu").onclick = () => toggleDrawer(!sidebar.classList.contains("open"));
drawerMask.onclick = () => toggleDrawer(false);
