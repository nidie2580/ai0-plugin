import * as chatSvc from '../src/chatService.js'

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
    try {
      return await chatSvc.handleChat(this.e)
    } catch (err) {
      logger.error(`[ai0-plugin] onMessage error: ${err.message}`)
      return false
    }
  }
}
