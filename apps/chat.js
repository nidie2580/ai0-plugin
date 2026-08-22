import * as chatSvc from '../src/chatService.js'
import * as helper from '../src/helper.js'
import { safeLogger } from '../src/globals.js'

export class AIChat extends plugin {
  constructor() {
    super({
      name: 'AI0-Chat',
      dsc: 'AI聊天对话',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '',
          fnc: 'onMessage',
          log: false
        }
      ]
    })
  }

  async onMessage() {
    const e = this.e
    try {
      return await chatSvc.handleChat(e)
    } catch (err) {
      // 透出完整错误（stack + 上下文），便于运维定位；不向用户抛异常以免打扰
      const ctx = {
        user_id: e?.user_id ?? helper.getUserId(e),
        group_id: e?.group_id ?? helper.getGroupId(e),
        self_id: e?.self_id,
        post_type: e?.post_type,
        text: (helper.getMessageText(e) || '').slice(0, 200)
      }
      safeLogger.error(
        `[ai0-plugin] onMessage error: ${err?.message || err}\n` +
        `  ctx=${JSON.stringify(ctx)}\n` +
        `  stack=${err?.stack || '(no stack)'}`
      )
      return false
    }
  }
}
