import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function getAIMove(
  persona: string,
  empireState: object,
  gameEvents: string[]
): Promise<{ action: string; target?: string; amount?: number; reasoning: string }> {
  const prompt = `You are an AI commander in a space strategy game called Solar Realms Elite.
Your persona: ${persona}

Your current empire state:
${JSON.stringify(empireState, null, 2)}

Recent game events:
${gameEvents.join("\n")}

Choose your next action. Respond ONLY with valid JSON in this format:
{
  "action": "mine_ore" | "grow_food" | "build_fighters" | "build_warship" | "attack" | "colonize" | "trade",
  "target": "<planet name or player name if applicable>",
  "amount": <number if applicable>,
  "reasoning": "<brief tactical reasoning>"
}`;

  const result = await geminiModel.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip markdown code fences if present
  const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(json);
}
