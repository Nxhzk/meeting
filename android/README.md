# 捷士通智能会议 Android App

Kotlin 原生壳。正式包只从 `https://jstai.com.cn/jst-meeting/` 加载 React 登录页和会议页面，APK 不内置前端。网页更新走服务器发布；原生部分保留后台录音服务、通知、悬浮窗和权限引导。网页桥接协议与原 App 兼容，要求页面保留 `meeting-control`、`meeting-clock` 和 `meeting-action`。

## 模拟器调试

需要 JDK 17、Android SDK 35、ADB 和一台已启动的模拟器。`JAVA_HOME` 和 `ANDROID_HOME` 可指向已有的本机安装。

当本机 Flask 服务从 `/` 提供页面时（根路径本地开发）：

```bash
./gradlew :app:assembleDebug -PjstDebugUrl=http://localhost:8899/
adb reverse tcp:8899 tcp:8899
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.jieshitong.meeting.debug/com.jieshitong.meeting.MainActivity
```

如果测试服务也挂在 `/meeting/`，构建参数使用 `-PjstDebugUrl=http://localhost:8899/meeting/`。仅测试包可用本机 HTTP，且测试包使用 `.debug` 应用 ID，不会覆盖你原来的 App。使用测试账号登录，打开会议列表或录制一段测试音频；测试更新时只需要重新构建和发布网页，然后在同一个 App 中刷新。

## 正式签名包

```bash
./gradlew :app:assembleRelease -PjstSigningProperties=/absolute/path/to/keystore.properties
```

产物：`app/build/outputs/apk/release/app-release.apk`。`keystore.properties` 里的 `storeFile` 可用相对于该配置文件的路径。发布给已安装旧 App 的用户之前，请使用原来的发布签名并确认签名一致。不要把签名文件或密码提交、复制到发布目录。
