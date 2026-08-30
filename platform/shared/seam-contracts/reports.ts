/** 证据链报告契约（业务控制面 §23.4）。 */

export const REPORT_SECTIONS = ['work_done', 'proof_of_work', 'verification', 'duration', 'cost', 'risk'] as const
export type ReportSectionName = (typeof REPORT_SECTIONS)[number]
export const REPORT_STATUSES = ['draft', 'confirmed', 'archived'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export interface ReportEvidence {
  sessionRef: string
  seq: number
}

export interface ReportSection {
  name: ReportSectionName
  content: unknown
  evidence: ReportEvidence[]
  verified: boolean
}

/** 无证据永远不能标记 verified；证据坐标保持可回溯，不复制日志正文。 */
export function reportSection(name: ReportSectionName, content: unknown, evidence: ReportEvidence[]): ReportSection {
  if (!(REPORT_SECTIONS as readonly string[]).includes(name)) throw new Error(`未知报告段 ${name}`)
  const clean = evidence.filter((item) => item.sessionRef !== '' && Number.isSafeInteger(item.seq) && item.seq >= 0)
  return { name, content, evidence: clean, verified: clean.length > 0 }
}

