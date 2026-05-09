// native 侧日志桥接：把 Rust 侧 `log` crate 产生的每条 Record 通过
// ThreadsafeFunction 异步投递给 TS 端的 logger 模块，汇聚到单一
// OutputChannel("jjvs")；同时装一次 panic hook，把 panic 的 payload + location
// 以 `log::error!` 的形式走同一条管道，省掉两套格式化逻辑。
//
// 设计要点：
//   - `log::set_logger` 要求 `&'static dyn Log`——用空结构体 `CallbackLogger` 的
//     常量引用；实际 tsfn 存放在 static OnceLock 里延迟写入，避免 `log::Log`
//     自身成为可变状态。
//   - 级别过滤两端都做：Rust 侧通过 `log::set_max_level` 早期短路（避免高频
//     `trace!` 每次都跨 ThreadsafeFunction boundary），TS 侧是唯一事实来源，
//     配置变更时调用 `set_native_log_level` 把目标级别同步过来。
//   - `ThreadsafeFunctionCallMode::NonBlocking`：日志热路径不等 TS 端处理；
//     队列被 napi-rs 默认无界缓冲。
//   - panic hook 只负责"记一条 error"，不拦截 unwind——napi-rs 3.x 自带
//     catch_unwind 把 panic 转成 napi::Error 返回 JS。

use std::backtrace::Backtrace;
use std::sync::OnceLock;

use log::{Level, LevelFilter};
use napi::bindgen_prelude::{Error, Result};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// 跨 Rust/TS 边界的日志载体。级别用 i32（napi-rs 的 Number → JS number），
/// 与 TS 侧 `LogLevel` 数值保持一致：error=0, warn=1, info=2, debug=3, trace=4。
/// 字段命名不改动——napi-rs 默认把 snake_case 映射成 camelCase 供 JS 使用，
/// 这里字段已是单个单词，两侧一致。
#[napi(object)]
pub struct NativeLogPayload {
    pub level: i32,
    pub tag: String,
    pub msg: String,
}

/// ThreadsafeFunction 的单例。`OnceLock::get()` 是无锁读，适合日志热路径；
/// 默认泛型参数 CalleeHandled=true，故 `.call(Ok(payload), NonBlocking)` 传 Result。
static TSFN: OnceLock<ThreadsafeFunction<NativeLogPayload>> = OnceLock::new();
static LOGGER: CallbackLogger = CallbackLogger;
/// panic hook 只装一次；多次 `set_native_logger`（理论上被 OnceLock 挡住，不
/// 会真发生）也不会重复叠加 hook。
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

struct CallbackLogger;

impl log::Log for CallbackLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        // `log::set_max_level` 已在 `log::Log::log` 前做全局过滤；额外再看 tsfn
        // 是否就位，`set_native_logger` 调用前的零星 log! 直接丢弃。
        TSFN.get().is_some()
    }

    fn log(&self, record: &log::Record) {
        // 贴合 log crate 契约：Log::log 实现内部应当先查 enabled。max_level
        // 过滤在 log! 宏展开时完成，但 set_logger 与 set_native_logger 之间的
        // 窗口里可能出现 "已是 global logger 但 TSFN 未装" 的瞬时状态。
        if !self.enabled(record.metadata()) {
            return;
        }
        let Some(tsfn) = TSFN.get() else {
            return;
        };
        let payload = NativeLogPayload {
            level: level_to_i32(record.level()),
            tag: record.target().to_string(),
            msg: format!("{}", record.args()),
        };
        // NonBlocking：日志丢包优先于阻塞 Rust 线程。返回 Status 忽略——队列
        // 满 / tsfn 已 abort 的场景下丢当前条是合理降级。
        let _ = tsfn.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
    }

    fn flush(&self) {}
}

fn level_to_i32(level: Level) -> i32 {
    match level {
        Level::Error => 0,
        Level::Warn => 1,
        Level::Info => 2,
        Level::Debug => 3,
        Level::Trace => 4,
    }
}

fn i32_to_level_filter(level: i32) -> Option<LevelFilter> {
    match level {
        0 => Some(LevelFilter::Error),
        1 => Some(LevelFilter::Warn),
        2 => Some(LevelFilter::Info),
        3 => Some(LevelFilter::Debug),
        4 => Some(LevelFilter::Trace),
        _ => None,
    }
}

/// 安装 TS 端 logger 回调。仅首次生效：再次调用返回错误，避免重复 `set_logger`。
///
/// 顺序：先 `log::set_logger`，再 `TSFN.set`。这样本次调用失败（例如别的依赖
/// 先占用了全局 Logger）时 TSFN 不会被装上，不会留下"TSFN 已设但不是 global
/// logger"的半成功状态。第二次调用 `set_native_logger` 时 `set_logger` 先
/// 失败，流程在 TSFN.set 之前就被截断——与"拒绝重入"语义一致。
#[napi]
pub fn set_native_logger(callback: ThreadsafeFunction<NativeLogPayload>) -> Result<()> {
    log::set_logger(&LOGGER)
        .map_err(|err| Error::from_reason(format!("全局 log::Logger 已被占用：{err}")))?;
    TSFN.set(callback)
        .map_err(|_| Error::from_reason("jjvs native logger 已安装，拒绝重复注册"))?;
    // 默认与 TS 侧 `currentLevel` 保持一致（info）；TS `attachNative` 会随即
    // 调 `set_native_log_level` 把最终级别推过来。不在这里默认 Trace：那会让
    // "attachNative 推级别"之前的短暂窗口里高频 trace 白跨 ThreadsafeFunction
    // boundary，也与"TS 侧作为级别事实来源"的注释矛盾。
    log::set_max_level(LevelFilter::Info);

    install_panic_hook_once();
    Ok(())
}

/// 同步 Rust 侧 `log` crate 的最大级别。TS 端 `setLevel(...)` 调用这里以避
/// 免 `trace` 日志每条都跨 ThreadsafeFunction boundary。
#[napi]
pub fn set_native_log_level(level: u32) -> Result<()> {
    let filter = i32_to_level_filter(level as i32)
        .ok_or_else(|| Error::from_reason(format!("无效的日志级别：{level}")))?;
    log::set_max_level(filter);
    Ok(())
}

fn install_panic_hook_once() {
    if PANIC_HOOK_INSTALLED.set(()).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = payload_as_str(info);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        // `Backtrace::capture` 受 `RUST_BACKTRACE` / `RUST_LIB_BACKTRACE`
        // 环境变量控制：未设置时返回 `Disabled`，Display 输出占位文本，
        // 近似零开销；设置后自动捕获完整堆栈。这里直接 format 进消息，
        // 让启用时能满足 ROADMAP "带时间戳的堆栈" 要求。
        let backtrace = Backtrace::capture();
        // 走 log::error! 让 panic 与常规日志格式一致，汇到 TS 端 OutputChannel；
        // target 命为 "panic"，TS 侧直接透出 tag。
        log::error!(
            target: "panic",
            "panic at {location}: {payload}\nbacktrace:\n{backtrace}"
        );
        // 保留原 hook（通常是 stderr 打印），不影响 napi-rs 的 catch_unwind。
        previous(info);
    }));
}

fn payload_as_str(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}
