import { z } from "zod";
import { defineMcpTool, textResult } from "../define-tool";

export const publishArtifactTool = defineMcpTool({
  name: "publish_artifact",
  description:
    "Publishes a file created by this agent to Agent UI. The file appears on " +
    "the Artifacts page and can be downloaded from the machine running Agent UI.",
  inputSchema: {
    path: z
      .string()
      .trim()
      .min(1)
      .describe("Absolute path, or relative to the session working directory"),
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional display and download name"),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional short description of the file"),
  },
  handler: async (input, services, context) => {
    if (!context.sessionId) {
      throw new Error(
        "Publishing artifacts requires a managed Agent UI session",
      );
    }
    const artifact = await services.artifactsService.publish({
      sessionId: context.sessionId,
      cwd: context.cwd,
      filePath: input.path,
      name: input.name,
      description: input.description,
    });
    return textResult(
      JSON.stringify({
        artifactId: artifact.id,
        name: artifact.name,
        path: artifact.path,
        message: `Published ${artifact.name} to Agent UI artifacts.`,
      }),
    );
  },
});
