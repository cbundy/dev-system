// The types of question.mjs.
export const OPTION_KEYS: readonly ['A', 'B', 'C', 'D', 'E', 'F']
export const QUESTION_FIELDS: readonly ['context', 'options', 'recommendation']
export const OPTIONS: Readonly<{ min: number; max: number }>
export const QUESTION_LIMITS: Readonly<{ context: number; optionTitle: number; optionDetail: number; recommendationReason: number }>
export const QUESTION_CAP: number
export const OPTIONS_NOTE: string

export type QuestionOption = { key: (typeof OPTION_KEYS)[number]; title: string; detail: string | null }
export type QuestionRecommendation = { key: (typeof OPTION_KEYS)[number]; reason: string }
// The optional parts of a checked question answer: present only when the answer gave them.
export type QuestionParts = { context?: string; options?: QuestionOption[]; recommendation?: QuestionRecommendation }

export function checkQuestionParts(
  o: Record<string, unknown>,
  decision: string | null,
  problems: string[],
): { context: string | null; options: QuestionOption[] | null; recommendation: QuestionRecommendation | null }
export function renderQuestion(q: { question: string; context?: string | null; options?: readonly QuestionOption[] | null; recommendation?: QuestionRecommendation | null }): string
