'use strict'
// Desktop 单进程 worker 的 fs-ext 原生锁定桩。
//
// fs-ext@2.1.1 的 C++ 扩展无法在打包 Node 24 的 V8 头上编译（v8-internal.h 的
// ExternalPointerTagRange 模板变化），而其唯一消费方 dsh-session-persistence-jsonl
// 在 POSIX 上用 `flock(2)` 做日志写入互斥。桌面 worker 是单进程：in-process
// write claim 已排除所有写入者 —— 与上游 browser-worker 部署的 stubbing 语义一致
// （dsh-session-persistence-jsonl/src/lease.ts 注释：stubs fs-ext to immediate
// success; it is single-process）。因此此处提供立即成功的 flock 桩，替换打包闭包
// 内复制出来的原生包体（见 build-runtime.mjs 的 stageFsExtStub）。
//
// 仅覆盖 JSONL 插件使用的 `flock` 回调式翻拍；若后续 master 增加其它 fs-ext
// 面（如 fs-ext/fh），按同样语义补桩即可（错误对象带 EAGAIN/EWOULDBLOCK 才表示
// 锁竞争，单进程下永不竞争）。
function flock(_fd, _flags, callback) {
  if (typeof callback === 'function') callback(null)
}

module.exports = { flock }
module.exports.flock = flock
