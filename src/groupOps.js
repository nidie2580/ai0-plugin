@@
 export async function parseAndExecuteActions(replyText, groupId, e = null) {
@@
-      const targetUid = args[0]
+      const targetUid = args[0]
+      // 基本格式校验：QQ 号通常为纯数字，长度在 5-20 位
+      if (!/^\d{5,20}$/.test(String(targetUid || ''))) {
+        results.push({ type, ok: false, msg: '目标 QQ 格式非法或未指定' })
+        continue
+      }
@@
 }
