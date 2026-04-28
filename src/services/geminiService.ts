import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface WasteInfo {
  itemName: string;
  category: string;
  disposalMethod: string;
  tips: string[];
}

export async function identifyWaste(base64Image: string): Promise<WasteInfo> {
  const prompt = `
    이 이미지에 있는 물체를 식별하고, 한국의 분리배출 기준에 따른 올바른 배출 방법을 알려주세요.
    응답은 반드시 한국어로 작성해야 하며, 아래 JSON 구조를 따라야 합니다.
    
    {
      "itemName": "물체 이름 (예: 페트병)",
      "category": "배출 카테고리 (예: 플라스틱, 병류, 일반쓰레기 등)",
      "disposalMethod": "상세한 배출 방법 설명",
      "tips": ["주의사항 1", "주의사항 2"]
    }
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image,
            },
          },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          itemName: { type: Type.STRING },
          category: { type: Type.STRING },
          disposalMethod: { type: Type.STRING },
          tips: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["itemName", "category", "disposalMethod", "tips"],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error("AI 응답을 생성하지 못했습니다.");
  
  return JSON.parse(text) as WasteInfo;
}
