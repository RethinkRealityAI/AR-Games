import { GoogleGenAI, Type } from "@google/genai";
import { CellValue, Player } from "../types";

// Initialize Gemini Client
// Note: In a real production app, keep API keys secure. 
// For this demo environment, we assume process.env.API_KEY is injected.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

const MODEL_NAME = 'gemini-2.5-flash';

export const getBestMove = async (board: CellValue[], currentPlayer: Player): Promise<number> => {
  try {
    // Construct a clear prompt for the model
    const boardString = JSON.stringify(board);
    const prompt = `
      You are an expert Tic-Tac-Toe engine. 
      The board is represented as a 1D array of 9 elements (indices 0-8).
      Current Board: ${boardString}
      You are playing as '${currentPlayer}'.
      
      Rules:
      1. You must pick an empty cell (value is null).
      2. If you can win immediately, pick that index.
      3. If the opponent is about to win, block them.
      4. Otherwise, pick the center or a strategic corner.
      
      Return ONLY the integer index (0-8) of your move.
    `;

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            moveIndex: { type: Type.INTEGER, description: "The index (0-8) of the best move." }
          },
          required: ["moveIndex"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");

    const result = JSON.parse(text);
    return result.moveIndex;

  } catch (error) {
    console.error("Gemini AI Error:", error);
    // Fallback: Pick first available random spot if AI fails
    const availableIndices = board
      .map((val, idx) => val === null ? idx : null)
      .filter((val) => val !== null) as number[];
    
    if (availableIndices.length > 0) {
      const randomMove = availableIndices[Math.floor(Math.random() * availableIndices.length)];
      return randomMove;
    }
    return -1;
  }
};
