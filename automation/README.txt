Egern Fork 自动同步

每个仓库默认分支上的 egern-upstream-sync.yml 每六小时运行一次，也支持 Actions 页面的 Run workflow。
程序及复用工作流集中保存在 imacte/Script-Hub 的 automation 分支。上游同步不会修改该维护分支。
每个调用仓库只使用自身临时 GITHUB_TOKEN（contents: write），没有保存跨仓库访问令牌。

同步内容
1. 默认分支合并上游更新，保留用户提交；冲突时停止并显示失败。
2. 六个使用 egern 分支的仓库合并新源码，再重新生成已知模块的个人下载地址。
3. WeatherKit、Sub-Store 查询最新正式版发布；下载所需附件，校验大小、SHA-256（上游提供时）和 JS 语法，再原子发布模块与附件。
4. WeatherKit 固定模块入口为 modules/WeatherKit.yaml，旧版本附件继续保留。
5. 网易云音乐所用 Gist 脚本同步到 imacte/Scripts/egern/vendor/netease.adblock.js，保留原作者说明及来源记录。
6. Script-Hub 中的 profiles/Egern.yaml 保留现有策略，只将天气模块改为固定入口。

分支保护方式
脚本通过三方文件合并保留非管理文件的修改；同一路径双方都修改时拒绝覆盖。
提交前再次检查分支头，更新引用时不使用强制覆盖。
原始上游 CI 工作流不会被自动启用。若 GitHub 临时令牌因上游工作流变更无法完成 merge-upstream，改为同步源码文件并保留仓库当前 CI 定义。
EGERN-SYNC-STATE.json 记录 egern 分支对应的默认分支基线及发布版本，.github/egern-upstream-state.json 记录源同步状态。
上游长期无更新时，每 28 天刷新一次同步状态，保持定时工作流所需的仓库活动。

运行时间
cron 按 UTC 每六小时运行，各仓库错开分钟，依赖仓库先运行。
北京时间对应凌晨 2 点、上午 8 点、下午 14 点、晚上 20 点所在小时，具体分钟见各仓库工作流。
GitHub 的定时触发可能延迟。失败会显示在该仓库 Actions 页面，并按账号现有通知设置发送 GitHub 通知。

维护
修改 automation 分支中的同步程序后，后续运行会使用新程序。
修改仓库名单时同时更新 sync-plan.json 和对应仓库的调用工作流。
公开配置模板不包含订阅链接或 MITM 证书；手机首次使用固定天气入口需要刷新一次配置。
