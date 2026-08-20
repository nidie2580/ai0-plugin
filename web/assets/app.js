  // ============== Login ==============
@@
   async function loadAbout() {
     const r = await api('/api/server-info')
     const info = r.info || {}
-    $('#aboutInfo').innerHTML = `
-      <div class="cmd-box">
- Web 后台状态：${info.running ? '运行中' : '未运行'}<br>
- 访问地址：${info.url || '-' }<br>
- 绑定 ${info.host || '-'} : ${info.port || '-'}
-       </div>
-       <p class="hint">如需长期开启，可在 config.yaml 中配置端口与绑定地址（绑定 0.0.0.0 可局域网访问）。</p>
-     `
+    $('#aboutInfo').innerHTML = `
+      <div class="cmd-box">
+ Web 后台状态：${info.running ? '运行中' : '未运行'}<br>
+ 访问地址：${escapeHtml(info.url || '-') }<br>
+ 绑定 ${escapeHtml(info.host || '-')} : ${escapeHtml(String(info.port || '-'))}
+       </div>
+       <p class="hint">如需长期开启，可在 config.yaml 中配置端口与绑定地址（绑定 0.0.0.0 可局域网访问）。</p>
+     `
   }
