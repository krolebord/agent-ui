import { defineMcpTool, textResult } from "../define-tool";

export const listSkillsTool = defineMcpTool({
  name: "list_skills",
  description:
    "Lists the Agent UI skills available to this session: global skills plus " +
    "skills from the session's project. Includes user-invoke-only skills " +
    "that are not auto-loaded into context. Each skill's full instructions " +
    "live in <dirPath>/SKILL.md. Rescans the skills directories first, so " +
    "call this after creating or editing skill files on disk to register " +
    "the changes with Agent UI.",
  inputSchema: {},
  handler: async (_input, services, context) => {
    const skills = await services.skillsService.listSkillsForPath(context.cwd);
    return textResult(
      JSON.stringify(
        {
          skills: skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            userInvokeOnly: skill.userInvokeOnly,
            dirPath: skill.dirPath,
          })),
        },
        null,
        2,
      ),
    );
  },
});
