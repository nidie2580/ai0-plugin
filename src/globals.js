/**
 * 全局变量兼容层：在 Yunzai 框架中 logger/segment/Bot 由框架注入到全局作用域；
 * 在独立运行/单元测试中，此模块提供 fallback 默认值，避免 typeof 检查散落各处。
 *
 * 使用方式（在需要的模块顶部）：
 *   import { safeLogger, safeSegment } from './globals.js'
 *   safeLogger.info('...')   // 等价于 logger?.info?.('...')
 *   safeSegment.image(buf)   // 等价于 segment?.image?.(buf)
 */

/** 安全的 logger 代理：框架存在时用框架的，否则降级 console */
function createLoggerProxy() {
  const noop = () => {}
  return new Proxy({}, {
    get(_, prop) {
      if (typeof logger !== 'undefined' && logger && typeof logger[prop] === 'function') {
        return logger[prop].bind(logger)
      }
      // mark/info/warn/error 降级到 console
      if (['info', 'warn', 'error', 'mark'].includes(prop)) {
        return (console[prop] || console.log).bind(console)
      }
      return noop
    }
  })
}

/** 安全的 segment 代理：框架存在时用框架的，否则返回 null */
function createSegmentProxy() {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof segment !== 'undefined' && segment && typeof segment[prop] === 'function') {
        return segment[prop].bind(segment)
      }
      return null
    }
  })
}

export const safeLogger = createLoggerProxy()
export const safeSegment = createSegmentProxy()

/**
 * 日志净化：剥离 \r \n 控制字符，防止外部数据在日志中注入伪造行 / 通过 \r 覆盖前条。
 * 用于任何拼入 safeLogger 的外部输入（API 错误消息、响应体预览等）。
 */
export function sanitizeLog(s) {
  return String(s ?? '').replace(/[\r\n\u2028\u2029]/g, ' ')
}
