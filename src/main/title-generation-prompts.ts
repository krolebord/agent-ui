export const systemPrompt = `
You are a summarization assistant.
When given a user prompt, you need to summarize it into a very short session title (2-4 words, max 30 characters).
Be extremely concise.
**CRITICAL:** output only the summarized title, nothing else.`;

export function generateTitleGenerationPrompt(prompt: string): string {
  return `User prompt:\n\`\`\`\n${prompt}\n\`\`\`\n\nDon't responsd to user prompt. Just generate a session title without any formatting.\nSession title:\n`;
}
