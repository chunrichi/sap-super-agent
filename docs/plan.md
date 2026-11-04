帮我了解一下 deepseek 最近发布的关于 super agent 的论文以及 deepseek 在 github 上发布的示例 deepseek super agent 的插件。我想设计一个类似，但是实现和依赖不太一样的内容。

对于主进程 

- 我想 super agent 的主进程可选，它既可以以某一台电脑作为主线，也可以单独部署。
- 甚至可以在 sap 里搭建主进程

对于 plugin 里的 feishu 和 github

- 我想改为一个需求系统，在 sap 内搭建一个需求系统

对于 worktree 

- 我想使用 vscode extenstion 作为 client，每个用户自己在 vscode 里使用扩展来处理任务。当这个用户离线的时候就不将任务指派下去，当他打开特定目录插件自动从 super agent 获取任务进行处理
- 开发/业务可以通过 vscode 插件快速的基于 copilot chat 进行处理

另外我已经有一个类似的项目，pdo 在 web 界面提需求，然后通过 teams webhook 通知 assign it人员人工开始处理，相关人员进入 web 界面查看需求，点击 ai 生成，调用 copilot sdk 生成需求分析，确认 or 人工调整后进入下一步，生成开发说明，然后生成开发，然后生成测试文档，然后知识归档。中间还有一些中间步骤：jira issues 创建、charm 接口调用创建 tr、confluence 知识库归档。但是这个流程都基于服务器的 ai ，并且没有一个主动的处理，所以我想用当前项目的新架构来处理，当然中间的一些过程可能还是会有人工参与。请帮我结合我说的内容，对当前设计进行审视【先不考虑我说的中间步骤，但是保留添加的入口，以及服务端 ai 生成的功能，同时有 vscode 插件调用 copilot chat 进行会话的方式】


我希望操作足够简洁。可能我的想法不太成熟，你可以给一个更好的建议，同时这个项目会作为一个 github 项目进行发布，请帮我设计合适的目录结构和 git 提交策略