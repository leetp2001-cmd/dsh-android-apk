"use strict";
/**
 * 统一鉴权入口：把三层认证组合成一个"这个请求能不能进来"的判断。
 *
 *   口令 cookie  ┐
 *                ├─→ 任一通过即放行
 *   边缘认证     ┘
 *
 * 这种情况下「或」是安全的：口令 cookie 只有本服务签发，边缘认证只有
 * 本机 cloudflared 能满足。两条路径各自独立成立，不存在互相放水。
 */

class Authenticator {
  constructor({ passphrase, edge, dshSession }) {
    this.passphrase = passphrase;
    this.edge = edge;
    this.dsh = dshSession;
  }

  /** 请求是否已通过口令或边缘认证 */
  isAuthorized(req) {
    return this.passphrase.hasCookie(req) || this.edge.matches(req);
  }

  /** 给 dsh 用的上游 cookie（铸票失败返回空串，让上游自己 401 而不是本层崩） */
  upstreamCookie() {
    return this.dsh.cookie();
  }
}

module.exports = { Authenticator };
