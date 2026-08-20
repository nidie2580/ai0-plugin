@@
-const packageJson = JSON.parse(
-  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
-)
-
-logger.info(`--------- AI0-Plugin v${packageJson.version} ---------`)
+const packageJson = JSON.parse(
+  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
+)
+
+if (typeof logger !== 'undefined' && typeof logger.info === 'function') {
+  logger.info(`--------- AI0-Plugin v${packageJson.version} ---------`)
+} else {
+  console.log(`--------- AI0-Plugin v${packageJson.version} ---------`)
+}
