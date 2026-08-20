@@
   function createApp() {
     const app = express()
     app.use(cookieParser())
     app.use(express.json({ limit: '10mb' }))
     app.use(express.urlencoded({ extended: true }))
+
+    // 简单内存速率限制中间件（针对特定路由）
+    const _rateMap = new Map()
+    function rateLimitMiddleware({ windowMs = 60_000, max = 6, id = 'rl' } = {}) {
+      return (req, res, next) => {
+        try {
+          const ip = req.clientIp || req.ip || 'unknown'
+          const key = `${id}:${ip}`
+          let rec = _rateMap.get(key)
+          const now = Date.now()
+          if (!rec || rec.resetAt < now) {
+            rec = { count: 0, resetAt: now + windowMs }
+            _rateMap.set(key, rec)
+          }
+          rec.count += 1
+          if (rec.count > max) return res.status(429).json({ ok: false, msg: '请求过于频繁，请稍后再试' })
+        } catch (_) {}
+        next()
+      }
+    }
@@
   app.get('/magic/:token', (req, res) => {
@@
-    const session = auth.issueSession()
-    res.cookie('ai0_session', session, {
-      httpOnly: true,
-      sameSite: 'lax',
-      maxAge: auth.AUTH_CFG.tokenExpireMs
-    })
+    const session = auth.issueSession()
+    const shouldSecure = req.secure || (cfg.get('web.trustProxy', false) && String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https')
+    res.cookie('ai0_session', session, {
+      httpOnly: true,
+      sameSite: 'lax',
+      maxAge: auth.AUTH_CFG.tokenExpireMs,
+      secure: !!shouldSecure
+    })
     return res.redirect('/')
   })
@@
   app.post('/api/login/code', (req, res) => {
@@
-    const session = auth.issueSession()
-    res.cookie('ai0_session', session, {
-      httpOnly: true,
-      sameSite: 'lax',
-      maxAge: auth.AUTH_CFG.tokenExpireMs
-    })
+    const session = auth.issueSession()
+    const shouldSecure2 = req.secure || (cfg.get('web.trustProxy', false) && String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https')
+    res.cookie('ai0_session', session, {
+      httpOnly: true,
+      sameSite: 'lax',
+      maxAge: auth.AUTH_CFG.tokenExpireMs,
+      secure: !!shouldSecure2
+    })
     res.json({ ok: true })
   })
@@
   app.post('/api/providers/probe', requireAuth, async (req, res) => {
+    // 限速：每 IP 每分钟最多 6 次探测
+  }, rateLimitMiddleware({ windowMs: 60_000, max: 6, id: 'probe' }), async (req, res) => {
-    const { modelKey = null } = req.body || {}
+    const { modelKey = null } = req.body || {}
@@
   app.post('/api/providers/probe-all', requireAuth, async (req, res) => {
-    try {
+    // 限速：每 IP 每分钟最多 3 次
+  }, rateLimitMiddleware({ windowMs: 60_000, max: 3, id: 'probe-all' }), async (req, res) => {
-    try {
+    try {
@@
   app.post('/api/test-model', requireAuth, async (req, res) => {
+    // 限速：每 IP 每分钟最多 6 次
+  }, rateLimitMiddleware({ windowMs: 60_000, max: 6, id: 'test-model' }), async (req, res) => {
     const { message = '请用一句话介绍你自己', modelKey = null } = req.body || {}
@@
   app.post('/api/test-image', requireAuth, async (req, res) => {
+    // 限速：每 IP 每分钟最多 6 次
+  }, rateLimitMiddleware({ windowMs: 60_000, max: 6, id: 'test-image' }), async (req, res) => {
     const { prompt } = req.body || {}
