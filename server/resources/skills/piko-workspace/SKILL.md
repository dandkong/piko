---
name: piko-workspace
description: Explain Piko workspace guidance, user skills, memory notes and artifacts when the user asks how their assistant workspace is organized.
---

# Piko 工作区

AGENTS.md 保存用户工作指导，SOUL.md 保存人格，USER.md 保存长期偏好，MEMORY.md 保存精简记忆。
用户技能位于 .agents/skills/<name>/SKILL.md，可包含 scripts/ 和 references/。
projects/ 用于专题工作，artifacts/ 用于交付物。业务数据库位于工作区之外。
可通过 read、write、edit 维护指导、记忆和技能，通过 bash 运行脚本；相对路径以工作区为基准，技能脚本与参考文件以技能目录为基准。
自动记忆提取与检索尚未实现，只有工具成功写入后才能确认已保存。
