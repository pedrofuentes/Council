import { Chalk } from "chalk";

import { colorDisabled } from "./tokens.js";

export const EXPERT_COLORS = ["magenta", "blue", "green", "yellow", "cyan", "red"] as const;

export type ExpertColor = (typeof EXPERT_COLORS)[number];

export interface ExpertPalette {
  color(key: string): (s: string) => string;
  boldColor(key: string): (s: string) => string;
  indexOf(key: string): number;
}

export function expertColorIndex(key: string): number {
  let sum = 0;
  for (let i = 0; i < key.length; i++) {
    sum += key.charCodeAt(i);
  }
  return sum % EXPERT_COLORS.length;
}

const identity = (s: string): string => s;

export function resolveExpertPalette(env: NodeJS.ProcessEnv = process.env): ExpertPalette {
  if (colorDisabled(env)) {
    return {
      indexOf: expertColorIndex,
      color: (_key: string) => identity,
      boldColor: (_key: string) => identity,
    };
  }
  const c = new Chalk({ level: 1 });
  return {
    indexOf: expertColorIndex,
    color(key: string): (s: string) => string {
      const idx = expertColorIndex(key);
      const colorName: ExpertColor = EXPERT_COLORS[idx] ?? EXPERT_COLORS[0];
      return (s: string) => c[colorName](s);
    },
    boldColor(key: string): (s: string) => string {
      const idx = expertColorIndex(key);
      const colorName: ExpertColor = EXPERT_COLORS[idx] ?? EXPERT_COLORS[0];
      return (s: string) => c[colorName].bold(s);
    },
  };
}
